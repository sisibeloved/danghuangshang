#!/usr/bin/env node
/**
 * Worktree Manager - 工部：Git Worktree 隔离系统
 *
 * @fileoverview 为多 Agent 并行编码提供 Git 级别的隔离
 * - 每个 Agent 的任务在独立的 git worktree 中执行
 * - 任务完成后可自动合并回主分支
 * - 冲突检测 + 安全清理
 *
 * @version 1.0.0
 * @author 工部
 *
 * 用法：
 *   node worktree-manager.js create --task task_123 --agent bingbu --base main
 *   node worktree-manager.js status --task task_123 --agent bingbu
 *   node worktree-manager.js merge --task task_123 --agent bingbu --target main
 *   node worktree-manager.js list
 *   node worktree-manager.js cleanup --max-age 24h
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { AppError, ErrorCode } = require('./error');
const log = require('./logger');
const { messageBus } = require('./message-bus');

const execFileAsync = promisify(execFile);

// ─── 配置 ────────────────────────────────────────────

const WORKTREE_DIR = '.worktrees';
const METADATA_FILE = '.worktree-meta.json';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// ─── WorktreeManager ─────────────────────────────────

class WorktreeManager {
  /**
   * @param {string} [repoRoot] - Git 仓库根目录（默认 cwd）
   */
  constructor(repoRoot = null) {
    this.repoRoot = repoRoot || process.cwd();
    this.worktreeBase = path.join(this.repoRoot, WORKTREE_DIR);
    this.metadataPath = path.join(this.worktreeBase, METADATA_FILE);
    this.metadata = this._loadMetadata();
  }

  // ─── 核心方法 ──────────────────────────────────────

  /**
   * 创建隔离的 git worktree
   * @param {string} taskId - 任务 ID
   * @param {string} agentId - Agent ID
   * @param {object} [options]
   * @param {string} [options.baseBranch='main'] - 基础分支
   * @param {string} [options.existingBranch] - 使用已有分支（而非新建）
   * @returns {Promise<{ worktreePath: string, branch: string }>}
   */
  async create(taskId, agentId, options = {}) {
    const { baseBranch = 'main', existingBranch = null } = options;
    const branch = existingBranch || `agent/${agentId}/task-${taskId}`;
    const worktreePath = this._getWorktreePath(taskId, agentId);

    // 检查是否已存在
    if (this.metadata[this._key(taskId, agentId)]) {
      const existing = this.metadata[this._key(taskId, agentId)];
      if (fs.existsSync(existing.path)) {
        log.info(`[Worktree] Already exists: ${branch}`);
        return { worktreePath: existing.path, branch: existing.branch };
      }
      // 元数据残留但目录不存在 → 清理后重建
      delete this.metadata[this._key(taskId, agentId)];
    }

    // 确保 .worktrees 目录存在
    if (!fs.existsSync(this.worktreeBase)) {
      fs.mkdirSync(this.worktreeBase, { recursive: true });
    }

    try {
      if (existingBranch) {
        // 使用已有分支
        await this._git(['worktree', 'add', worktreePath, existingBranch]);
      } else {
        // 创建新分支
        await this._git(['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
      }

      // 记录元数据
      this.metadata[this._key(taskId, agentId)] = {
        taskId,
        agentId,
        branch,
        path: worktreePath,
        baseBranch,
        createdAt: new Date().toISOString(),
        status: 'active'
      };
      this._saveMetadata();

      log.info(`[Worktree] Created: ${branch} at ${worktreePath}`);
      messageBus.publish('worktree.created', { taskId, agentId, branch, path: worktreePath });

      return { worktreePath, branch };
    } catch (err) {
      log.error(`[Worktree] Failed to create: ${branch}`, { error: err.message });
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Worktree 创建失败: ${err.message}`,
        { taskId, agentId, branch },
        err
      );
    }
  }

  /**
   * 移除 worktree
   * @param {string} taskId
   * @param {string} agentId
   * @param {object} [options]
   * @param {boolean} [options.force=false] - 强制删除（即使有未提交更改）
   * @param {boolean} [options.deleteBranch=false] - 同时删除分支
   * @returns {Promise<void>}
   */
  async remove(taskId, agentId, options = {}) {
    const { force = false, deleteBranch = false } = options;
    const key = this._key(taskId, agentId);
    const meta = this.metadata[key];

    if (!meta) {
      log.warn(`[Worktree] Not found in metadata: ${key}`);
      return;
    }

    // 安全检查：有未提交更改？
    if (!force) {
      const hasChanges = await this.hasChanges(taskId, agentId);
      if (hasChanges) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          `Worktree 有未提交更改，拒绝删除（使用 --force 强制）`,
          { taskId, agentId, path: meta.path }
        );
      }
    }

    try {
      // 移除 worktree
      const args = ['worktree', 'remove', meta.path];
      if (force) args.push('--force');
      await this._git(args);

      // 可选：删除分支
      if (deleteBranch && meta.branch) {
        try {
          await this._git(['branch', '-D', meta.branch]);
        } catch {
          // 分支可能已被删除或合并，忽略
        }
      }

      // 更新元数据
      meta.status = 'removed';
      meta.removedAt = new Date().toISOString();
      delete this.metadata[key];
      this._saveMetadata();

      log.info(`[Worktree] Removed: ${meta.branch}`);
      messageBus.publish('worktree.removed', { taskId, agentId, branch: meta.branch });
    } catch (err) {
      log.error(`[Worktree] Failed to remove: ${meta.branch}`, { error: err.message });
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Worktree 删除失败: ${err.message}`,
        { taskId, agentId },
        err
      );
    }
  }

  /**
   * 获取 worktree 信息
   * @param {string} taskId
   * @param {string} agentId
   * @returns {object|null}
   */
  getWorktree(taskId, agentId) {
    return this.metadata[this._key(taskId, agentId)] || null;
  }

  /**
   * 列出所有活跃的 worktrees
   * @returns {object[]}
   */
  listWorktrees() {
    return Object.values(this.metadata).filter(m => m.status === 'active');
  }

  /**
   * 检查 worktree 是否有未提交的更改
   * @param {string} taskId
   * @param {string} agentId
   * @returns {Promise<boolean>}
   */
  async hasChanges(taskId, agentId) {
    const meta = this.metadata[this._key(taskId, agentId)];
    if (!meta || !fs.existsSync(meta.path)) return false;

    try {
      const { stdout } = await this._gitIn(meta.path, ['status', '--porcelain']);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 列出 worktree 中修改的文件
   * @param {string} taskId
   * @param {string} agentId
   * @returns {Promise<string[]>}
   */
  async listModifiedFiles(taskId, agentId) {
    const meta = this.metadata[this._key(taskId, agentId)];
    if (!meta) return [];

    try {
      // 对比 worktree 分支与基础分支
      const { stdout } = await this._gitIn(meta.path, [
        'diff', '--name-only', `${meta.baseBranch}...HEAD`
      ]);
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * 预览合并冲突（不实际合并）
   * @param {string} taskId
   * @param {string} agentId
   * @param {string} [targetBranch='main']
   * @returns {Promise<{ hasConflicts: boolean, conflicts: string[] }>}
   */
  async getConflicts(taskId, agentId, targetBranch = 'main') {
    const meta = this.metadata[this._key(taskId, agentId)];
    if (!meta) {
      return { hasConflicts: false, conflicts: [] };
    }

    try {
      // 尝试 dry-run merge
      await this._gitIn(meta.path, ['merge', '--no-commit', '--no-ff', targetBranch]);
      // 没有冲突 → 回滚
      await this._gitIn(meta.path, ['merge', '--abort']);
      return { hasConflicts: false, conflicts: [] };
    } catch (err) {
      // 有冲突
      try {
        const { stdout } = await this._gitIn(meta.path, ['diff', '--name-only', '--diff-filter=U']);
        const conflicts = stdout.trim().split('\n').filter(Boolean);
        // 回滚
        await this._gitIn(meta.path, ['merge', '--abort']).catch(() => {});
        return { hasConflicts: true, conflicts };
      } catch {
        await this._gitIn(meta.path, ['merge', '--abort']).catch(() => {});
        return { hasConflicts: true, conflicts: [err.message] };
      }
    }
  }

  /**
   * 合并 Agent 的工作到目标分支
   * @param {string} taskId
   * @param {string} agentId
   * @param {string} [targetBranch='main']
   * @returns {Promise<{ success: boolean, conflicts?: string[] }>}
   */
  async merge(taskId, agentId, targetBranch = 'main') {
    const meta = this.metadata[this._key(taskId, agentId)];
    if (!meta) {
      throw new AppError(
        ErrorCode.AGENT_NOT_FOUND,
        `Worktree 不存在: ${taskId}/${agentId}`,
        { taskId, agentId }
      );
    }

    // 先检查冲突
    const { hasConflicts, conflicts } = await this.getConflicts(taskId, agentId, targetBranch);
    if (hasConflicts) {
      log.warn(`[Worktree] Merge conflicts detected: ${meta.branch} -> ${targetBranch}`, { conflicts });
      messageBus.publish('worktree.conflict', { taskId, agentId, branch: meta.branch, targetBranch, conflicts });
      return { success: false, conflicts };
    }

    try {
      // 在主仓库中合并
      await this._git(['checkout', targetBranch]);
      await this._git(['merge', '--no-ff', meta.branch, '-m',
        `合并 ${agentId} 的工作 (task: ${taskId})`
      ]);

      log.info(`[Worktree] Merged: ${meta.branch} -> ${targetBranch}`);
      messageBus.publish('worktree.merged', {
        taskId, agentId, branch: meta.branch, targetBranch
      });

      return { success: true };
    } catch (err) {
      // 合并失败 → 回滚
      await this._git(['merge', '--abort']).catch(() => {});
      log.error(`[Worktree] Merge failed: ${meta.branch} -> ${targetBranch}`, { error: err.message });
      return { success: false, conflicts: [err.message] };
    }
  }

  /**
   * 清理过期的 worktrees
   * @param {object} [options]
   * @param {number} [options.maxAgeMs] - 最大存活时间
   * @param {boolean} [options.force=false] - 强制删除有更改的 worktree
   * @returns {Promise<string[]>} 被清理的 key 列表
   */
  async cleanup(options = {}) {
    const { maxAgeMs = DEFAULT_MAX_AGE_MS, force = false } = options;
    const now = Date.now();
    const cleaned = [];

    for (const [key, meta] of Object.entries(this.metadata)) {
      if (meta.status !== 'active') continue;

      const age = now - new Date(meta.createdAt).getTime();
      const isStale = age > maxAgeMs;
      const isOrphaned = !fs.existsSync(meta.path);

      if (isStale || isOrphaned) {
        try {
          if (isOrphaned) {
            // 目录已不存在，只清理元数据
            delete this.metadata[key];
            cleaned.push(key);
          } else {
            await this.remove(meta.taskId, meta.agentId, { force });
            cleaned.push(key);
          }
        } catch (err) {
          log.warn(`[Worktree] Cleanup skipped ${key}: ${err.message}`);
        }
      }
    }

    if (cleaned.length > 0) {
      this._saveMetadata();
      log.info(`[Worktree] Cleaned up ${cleaned.length} stale worktrees`);
    }
    return cleaned;
  }

  // ─── 内部方法 ──────────────────────────────────────

  /**
   * 在主仓库执行 git 命令
   * @private
   */
  async _git(args) {
    return execFileAsync('git', args, { cwd: this.repoRoot, maxBuffer: 10 * 1024 * 1024 });
  }

  /**
   * 在指定目录执行 git 命令
   * @private
   */
  async _gitIn(dir, args) {
    return execFileAsync('git', args, { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
  }

  /**
   * 生成 worktree 路径
   * @private
   */
  _getWorktreePath(taskId, agentId) {
    return path.join(this.worktreeBase, `${agentId}-${taskId}`);
  }

  /**
   * 生成 metadata key
   * @private
   */
  _key(taskId, agentId) {
    return `${agentId}:${taskId}`;
  }

  /**
   * 加载元数据
   * @private
   */
  _loadMetadata() {
    try {
      if (fs.existsSync(this.metadataPath)) {
        return JSON.parse(fs.readFileSync(this.metadataPath, 'utf-8'));
      }
    } catch (e) {
      log.warn(`[Worktree] Failed to load metadata: ${e.message}`);
    }
    return {};
  }

  /**
   * 保存元数据
   * @private
   */
  _saveMetadata() {
    try {
      if (!fs.existsSync(this.worktreeBase)) {
        fs.mkdirSync(this.worktreeBase, { recursive: true });
      }
      fs.writeFileSync(this.metadataPath, JSON.stringify(this.metadata, null, 2));
    } catch (e) {
      log.error(`[Worktree] Failed to save metadata: ${e.message}`);
    }
  }
}

// ─── 单例 ────────────────────────────────────────────

const worktreeManager = new WorktreeManager();

// ─── CLI ─────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : null;
  }

  (async () => {
    try {
      switch (command) {
        case 'create': {
          const taskId = getArg('task');
          const agentId = getArg('agent');
          const baseBranch = getArg('base') || 'main';
          if (!taskId || !agentId) {
            console.error('需要 --task 和 --agent 参数');
            process.exit(1);
          }
          const result = await worktreeManager.create(taskId, agentId, { baseBranch });
          console.log(`✅ Worktree 已创建`);
          console.log(`   分支: ${result.branch}`);
          console.log(`   路径: ${result.worktreePath}`);
          break;
        }

        case 'status': {
          const taskId = getArg('task');
          const agentId = getArg('agent');
          if (!taskId || !agentId) {
            console.error('需要 --task 和 --agent 参数');
            process.exit(1);
          }
          const meta = worktreeManager.getWorktree(taskId, agentId);
          if (!meta) {
            console.log('❌ Worktree 不存在');
            process.exit(1);
          }
          const hasChanges = await worktreeManager.hasChanges(taskId, agentId);
          const files = await worktreeManager.listModifiedFiles(taskId, agentId);
          console.log(JSON.stringify({
            ...meta,
            hasUncommittedChanges: hasChanges,
            modifiedFiles: files
          }, null, 2));
          break;
        }

        case 'merge': {
          const taskId = getArg('task');
          const agentId = getArg('agent');
          const target = getArg('target') || 'main';
          if (!taskId || !agentId) {
            console.error('需要 --task 和 --agent 参数');
            process.exit(1);
          }
          const result = await worktreeManager.merge(taskId, agentId, target);
          if (result.success) {
            console.log(`✅ 已合并到 ${target}`);
          } else {
            console.error(`❌ 合并失败，冲突文件:`);
            result.conflicts.forEach(f => console.error(`   ${f}`));
            process.exit(1);
          }
          break;
        }

        case 'list': {
          const worktrees = worktreeManager.listWorktrees();
          if (worktrees.length === 0) {
            console.log('当前无活跃的 worktrees');
          } else {
            console.log(`活跃的 Worktrees (${worktrees.length}):\n`);
            for (const wt of worktrees) {
              console.log(`  🌿 ${wt.branch}`);
              console.log(`     Agent: ${wt.agentId} | Task: ${wt.taskId}`);
              console.log(`     路径: ${wt.path}`);
              console.log(`     创建: ${wt.createdAt}`);
              console.log();
            }
          }
          break;
        }

        case 'cleanup': {
          const maxAge = getArg('max-age');
          const force = args.includes('--force');
          let maxAgeMs = DEFAULT_MAX_AGE_MS;

          if (maxAge) {
            const match = maxAge.match(/^(\d+)(h|m|d)$/);
            if (match) {
              const [, num, unit] = match;
              const multiplier = { h: 3600000, m: 60000, d: 86400000 };
              maxAgeMs = parseInt(num) * multiplier[unit];
            }
          }

          const cleaned = await worktreeManager.cleanup({ maxAgeMs, force });
          console.log(`🧹 清理了 ${cleaned.length} 个过期 worktrees`);
          if (cleaned.length > 0) {
            cleaned.forEach(k => console.log(`   ${k}`));
          }
          break;
        }

        case 'conflicts': {
          const taskId = getArg('task');
          const agentId = getArg('agent');
          const target = getArg('target') || 'main';
          if (!taskId || !agentId) {
            console.error('需要 --task 和 --agent 参数');
            process.exit(1);
          }
          const result = await worktreeManager.getConflicts(taskId, agentId, target);
          if (result.hasConflicts) {
            console.log(`⚠️ 存在冲突 (${result.conflicts.length} 个文件):`);
            result.conflicts.forEach(f => console.log(`   ${f}`));
          } else {
            console.log('✅ 无冲突，可安全合并');
          }
          break;
        }

        case 'files': {
          const taskId = getArg('task');
          const agentId = getArg('agent');
          if (!taskId || !agentId) {
            console.error('需要 --task 和 --agent 参数');
            process.exit(1);
          }
          const files = await worktreeManager.listModifiedFiles(taskId, agentId);
          if (files.length === 0) {
            console.log('无修改文件');
          } else {
            console.log(`修改文件 (${files.length}):`);
            files.forEach(f => console.log(`   ${f}`));
          }
          break;
        }

        default:
          console.log(`工部 — Git Worktree 隔离系统

用法：
  node worktree-manager.js create   --task <id> --agent <id> [--base main]
  node worktree-manager.js status   --task <id> --agent <id>
  node worktree-manager.js merge    --task <id> --agent <id> [--target main]
  node worktree-manager.js list
  node worktree-manager.js conflicts --task <id> --agent <id> [--target main]
  node worktree-manager.js files    --task <id> --agent <id>
  node worktree-manager.js cleanup  [--max-age 24h] [--force]

示例：
  node worktree-manager.js create --task task_001 --agent bingbu --base main
  node worktree-manager.js merge --task task_001 --agent bingbu --target main
  node worktree-manager.js cleanup --max-age 12h`);
      }
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = {
  WorktreeManager,
  worktreeManager
};
