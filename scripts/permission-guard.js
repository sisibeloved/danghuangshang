#!/usr/bin/env node
/**
 * Permission Guard - 门下省：事前权限拦截层
 *
 * @fileoverview 基于三省六部制的权限拦截系统
 * - 每个 Agent 调用其他 Agent / 执行 Skill / 操作任务前，必须过门下省审查
 * - 权限矩阵可通过 JSON 文件配置，默认按明朝官制设定
 * - 所有拒绝操作通过 AppError(PERMISSION_DENIED) 抛出
 *
 * @version 1.0.0
 * @author 门下省
 *
 * 用法：
 *   const { permissionGuard } = require('./permission-guard');
 *
 *   // 检查 Agent 调用权限
 *   permissionGuard.checkAgentCall('silijian', 'bingbu');  // OK
 *   permissionGuard.checkAgentCall('hubu', 'bingbu');      // throws PERMISSION_DENIED
 *
 *   // 通用拦截
 *   permissionGuard.intercept('bingbu', { type: 'skill', skill: 'github' });
 */

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCode } = require('./error');
const log = require('./logger');
const { messageBus } = require('./message-bus');

// ─── 常量 ───────────────────────────────────────────────

/**
 * 操作类型枚举
 */
const ActionType = {
  AGENT_CALL: 'agent_call',
  SKILL_EXEC: 'skill_exec',
  TASK_OP: 'task_op',
  FILE_ACCESS: 'file_access'
};

/**
 * 任务操作枚举
 */
const TaskOperation = {
  CREATE: 'create',
  UPDATE: 'update',
  CANCEL: 'cancel',
  READ: 'read'
};

/**
 * 文件访问模式
 */
const FileMode = {
  READ: 'read',
  WRITE: 'write'
};

// ─── 默认权限矩阵（明朝内阁制） ─────────────────────────

/**
 * 默认权限配置
 *
 * 设计原则：
 * - 司礼监：总调度，权限最高
 * - 内阁：顾问角色，不直接指挥六部
 * - 六部：各司其职，只能用本部门相关技能
 * - 都察院：独立监察，只读权限 + 审查报告写入
 * - 翰林院：文学系统，只与其他翰林交互
 */
const DEFAULT_PERMISSIONS = {
  // 司礼监 — 总调度，权限最高
  silijian: {
    agents: ['*'],                    // 可调用所有 Agent
    skills: ['*'],                    // 可执行所有 Skill
    taskOps: ['create', 'update', 'cancel', 'read'],
    fileAccess: {
      read: ['*'],
      write: ['*']
    }
  },

  // 内阁 — 顾问，不直接指挥六部
  neige: {
    agents: [],                       // 不直接调用 Agent（只向司礼监建议）
    skills: ['self-improving-agent', 'quadrants'],
    taskOps: ['read'],                // 只读任务状态
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd/neige/']      // 只能写自己的工作区
    }
  },

  // 兵部 — 软件工程
  bingbu: {
    agents: [],
    skills: ['github', 'browser-use', 'self-improving-agent'],
    taskOps: ['update', 'read'],      // 可以更新自己的任务步骤
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-bingbu/', '.worktrees/bingbu-*']
    }
  },

  // 户部 — 财务分析
  hubu: {
    agents: [],
    skills: ['notion', 'quadrants', 'self-improving-agent'],
    taskOps: ['update', 'read'],
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-hubu/']
    }
  },

  // 礼部 — 品牌营销
  libu: {
    agents: [],
    skills: ['notion', 'hacker-news', 'weather', 'self-improving-agent'],
    taskOps: ['update', 'read'],
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-libu/']
    }
  },

  // 工部 — 运维部署
  gongbu: {
    agents: [],
    skills: ['github', 'browser-use', 'self-improving-agent'],
    taskOps: ['update', 'read'],
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-gongbu/', '.worktrees/gongbu-*']
    }
  },

  // 吏部 — 项目管理
  libu2: {
    agents: [],
    skills: ['notion', 'quadrants', 'self-improving-agent'],
    taskOps: ['create', 'update', 'read'],  // 可以创建任务
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-libu2/']
    }
  },

  // 刑部 — 法务合规
  xingbu: {
    agents: [],
    skills: ['self-improving-agent'],
    taskOps: ['read'],
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-xingbu/']
    }
  },

  // 都察院 — 独立审查（只读 + 审查报告）
  duchayuan: {
    agents: [],
    skills: ['github', 'self-improving-agent'],
    taskOps: ['update', 'read'],      // 可以更新审查结果
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-duchayuan/', 'reviews/']
    }
  },

  // 内务府
  neiwufu: {
    agents: [],
    skills: ['weather', 'self-improving-agent'],
    taskOps: ['read'],
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-neiwufu/']
    }
  },

  // 起居注
  qijuzhu: {
    agents: [],
    skills: ['self-improving-agent'],
    taskOps: ['read'],
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-qijuzhu/', 'logs/']
    }
  },

  // 太医院
  taiyiyuan: {
    agents: [],
    skills: ['self-improving-agent'],
    taskOps: ['read'],
    fileAccess: {
      read: ['*'],
      write: ['~/.clawd-taiyiyuan/']
    }
  }
};

/**
 * 翰林院默认权限（前缀匹配 hanlin_*）
 */
const HANLIN_DEFAULT_PERMISSIONS = {
  agents: ['hanlin_*'],               // 只能与其他翰林交互
  skills: ['novel-*', 'self-improving-agent'],  // 只能用小说相关技能
  taskOps: ['update', 'read'],
  fileAccess: {
    read: ['*'],
    write: ['~/.clawd-hanlin*/', 'novels/']
  }
};

// ─── 配置文件路径 ─────────────────────────────────────

const CONFIG_PATH = process.env.PERMISSION_CONFIG_PATH
  || path.join(process.env.HOME || '/tmp', '.clawd', 'permissions.json');

// ─── PermissionGuard 类 ──────────────────────────────────

class PermissionGuard {
  /**
   * @param {object} [customPermissions] - 自定义权限矩阵（覆盖默认）
   */
  constructor(customPermissions = null) {
    this.permissions = this._loadPermissions(customPermissions);
    this.auditLog = [];
    this.maxAuditLog = 500;
  }

  // ─── 核心检查方法 ──────────────────────────────────

  /**
   * 检查 Agent 是否可以调用另一个 Agent
   * @param {string} caller - 调用方 Agent ID
   * @param {string} target - 目标 Agent ID
   * @returns {boolean}
   * @throws {AppError} PERMISSION_DENIED
   */
  checkAgentCall(caller, target) {
    const perms = this._getPermissions(caller);
    const allowed = this._matchesPattern(target, perms.agents);

    this._audit(caller, ActionType.AGENT_CALL, { target }, allowed);

    if (!allowed) {
      const err = new AppError(
        ErrorCode.PERMISSION_DENIED,
        `[门下省] 驳回：${caller} 无权调用 ${target}`,
        { caller, target, action: ActionType.AGENT_CALL }
      );
      log.warn(`[Permission] Denied agent call: ${caller} -> ${target}`);
      messageBus.publish('permission.denied', { caller, target, action: ActionType.AGENT_CALL });
      throw err;
    }

    log.debug(`[Permission] Allowed agent call: ${caller} -> ${target}`);
    return true;
  }

  /**
   * 检查 Agent 是否可以执行某个 Skill
   * @param {string} agentId - Agent ID
   * @param {string} skillName - Skill 名称
   * @returns {boolean}
   * @throws {AppError} PERMISSION_DENIED
   */
  checkSkillExecution(agentId, skillName) {
    const perms = this._getPermissions(agentId);
    const allowed = this._matchesPattern(skillName, perms.skills);

    this._audit(agentId, ActionType.SKILL_EXEC, { skill: skillName }, allowed);

    if (!allowed) {
      const err = new AppError(
        ErrorCode.PERMISSION_DENIED,
        `[门下省] 驳回：${agentId} 无权执行技能 ${skillName}`,
        { agentId, skillName, action: ActionType.SKILL_EXEC }
      );
      log.warn(`[Permission] Denied skill execution: ${agentId} -> ${skillName}`);
      messageBus.publish('permission.denied', { agentId, skillName, action: ActionType.SKILL_EXEC });
      throw err;
    }

    log.debug(`[Permission] Allowed skill execution: ${agentId} -> ${skillName}`);
    return true;
  }

  /**
   * 检查 Agent 是否可以执行某个任务操作
   * @param {string} agentId - Agent ID
   * @param {string} operation - 操作类型 (create/update/cancel/read)
   * @param {string} [taskId] - 任务 ID（可选，用于细粒度控制）
   * @returns {boolean}
   * @throws {AppError} PERMISSION_DENIED
   */
  checkTaskOperation(agentId, operation, taskId = null) {
    const perms = this._getPermissions(agentId);
    const allowed = perms.taskOps.includes(operation);

    this._audit(agentId, ActionType.TASK_OP, { operation, taskId }, allowed);

    if (!allowed) {
      const err = new AppError(
        ErrorCode.PERMISSION_DENIED,
        `[门下省] 驳回：${agentId} 无权执行任务操作 ${operation}`,
        { agentId, operation, taskId, action: ActionType.TASK_OP }
      );
      log.warn(`[Permission] Denied task op: ${agentId} -> ${operation} (task: ${taskId})`);
      messageBus.publish('permission.denied', { agentId, operation, taskId, action: ActionType.TASK_OP });
      throw err;
    }

    log.debug(`[Permission] Allowed task op: ${agentId} -> ${operation}`);
    return true;
  }

  /**
   * 检查 Agent 是否可以访问某个文件
   * @param {string} agentId - Agent ID
   * @param {string} filePath - 文件路径
   * @param {string} mode - 访问模式 ('read' | 'write')
   * @returns {boolean}
   * @throws {AppError} PERMISSION_DENIED
   */
  checkFileAccess(agentId, filePath, mode) {
    const perms = this._getPermissions(agentId);
    const patterns = (mode === FileMode.WRITE) ? perms.fileAccess.write : perms.fileAccess.read;
    const normalizedPath = this._normalizePath(filePath);
    const allowed = this._matchesPathPattern(normalizedPath, patterns);

    this._audit(agentId, ActionType.FILE_ACCESS, { filePath, mode }, allowed);

    if (!allowed) {
      const err = new AppError(
        ErrorCode.PERMISSION_DENIED,
        `[门下省] 驳回：${agentId} 无权${mode === 'write' ? '写入' : '读取'}文件 ${filePath}`,
        { agentId, filePath, mode, action: ActionType.FILE_ACCESS }
      );
      log.warn(`[Permission] Denied file ${mode}: ${agentId} -> ${filePath}`);
      messageBus.publish('permission.denied', { agentId, filePath, mode, action: ActionType.FILE_ACCESS });
      throw err;
    }

    log.debug(`[Permission] Allowed file ${mode}: ${agentId} -> ${filePath}`);
    return true;
  }

  /**
   * 通用拦截器 — 路由到对应的检查方法
   * @param {string} agentId - Agent ID
   * @param {object} action - 操作描述
   * @param {string} action.type - 操作类型 (agent_call/skill_exec/task_op/file_access)
   * @param {string} [action.target] - 目标 Agent
   * @param {string} [action.skill] - 技能名称
   * @param {string} [action.operation] - 任务操作
   * @param {string} [action.taskId] - 任务 ID
   * @param {string} [action.filePath] - 文件路径
   * @param {string} [action.mode] - 文件访问模式
   * @returns {boolean}
   * @throws {AppError} PERMISSION_DENIED
   */
  intercept(agentId, action) {
    switch (action.type) {
      case ActionType.AGENT_CALL:
        return this.checkAgentCall(agentId, action.target);
      case ActionType.SKILL_EXEC:
        return this.checkSkillExecution(agentId, action.skill);
      case ActionType.TASK_OP:
        return this.checkTaskOperation(agentId, action.operation, action.taskId);
      case ActionType.FILE_ACCESS:
        return this.checkFileAccess(agentId, action.filePath, action.mode);
      default:
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          `[门下省] 未知操作类型: ${action.type}`,
          { agentId, action }
        );
    }
  }

  // ─── 查询方法 ──────────────────────────────────────

  /**
   * 获取某个 Agent 的权限摘要
   * @param {string} agentId
   * @returns {object}
   */
  getPermissionSummary(agentId) {
    const perms = this._getPermissions(agentId);
    return {
      agentId,
      canCallAgents: perms.agents,
      canUseSkills: perms.skills,
      taskOperations: perms.taskOps,
      fileAccess: perms.fileAccess,
      source: this.permissions[agentId] ? 'explicit' : (agentId.startsWith('hanlin_') ? 'hanlin_default' : 'unknown')
    };
  }

  /**
   * 列出所有已配置的权限
   * @returns {object}
   */
  listPermissions() {
    const result = {};
    for (const [agentId, perms] of Object.entries(this.permissions)) {
      result[agentId] = {
        agents: perms.agents,
        skills: perms.skills,
        taskOps: perms.taskOps,
        fileWrite: perms.fileAccess.write
      };
    }
    return result;
  }

  /**
   * 获取审计日志
   * @param {number} [limit=50]
   * @returns {Array}
   */
  getAuditLog(limit = 50) {
    return this.auditLog.slice(-limit);
  }

  /**
   * 重新加载权限配置
   */
  reload() {
    this.permissions = this._loadPermissions(null);
    log.info('[Permission] Reloaded permission config');
  }

  // ─── 内部方法 ──────────────────────────────────────

  /**
   * 加载权限配置：自定义 > 文件 > 默认
   * @private
   */
  _loadPermissions(customPermissions) {
    // 1. 自定义传入
    if (customPermissions) {
      log.info('[Permission] Using custom permission matrix');
      return { ...DEFAULT_PERMISSIONS, ...customPermissions };
    }

    // 2. 尝试从文件加载
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const filePerms = JSON.parse(raw);
        log.info(`[Permission] Loaded permissions from ${CONFIG_PATH}`);
        return { ...DEFAULT_PERMISSIONS, ...filePerms };
      }
    } catch (e) {
      log.warn(`[Permission] Failed to load config from ${CONFIG_PATH}: ${e.message}`);
    }

    // 3. 使用默认
    log.info('[Permission] Using default permission matrix (Ming Dynasty)');
    return { ...DEFAULT_PERMISSIONS };
  }

  /**
   * 获取 Agent 的权限（支持翰林院前缀匹配）
   * @private
   */
  _getPermissions(agentId) {
    // 精确匹配
    if (this.permissions[agentId]) {
      return this.permissions[agentId];
    }

    // 翰林院前缀匹配
    if (agentId.startsWith('hanlin_')) {
      return HANLIN_DEFAULT_PERMISSIONS;
    }

    // 未知 Agent — 最小权限（只读）
    log.warn(`[Permission] Unknown agent: ${agentId}, applying minimal permissions`);
    return {
      agents: [],
      skills: [],
      taskOps: ['read'],
      fileAccess: { read: ['*'], write: [] }
    };
  }

  /**
   * 通配符匹配（支持 * 和 prefix_*）
   * @private
   */
  _matchesPattern(value, patterns) {
    if (!patterns || patterns.length === 0) return false;

    for (const pattern of patterns) {
      if (pattern === '*') return true;
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (value.startsWith(prefix)) return true;
      }
      if (pattern === value) return true;
    }
    return false;
  }

  /**
   * 文件路径通配符匹配
   * @private
   */
  _matchesPathPattern(filePath, patterns) {
    if (!patterns || patterns.length === 0) return false;

    for (const pattern of patterns) {
      if (pattern === '*') return true;

      const normalizedPattern = this._normalizePath(pattern);

      // 前缀匹配（目录）
      if (normalizedPattern.endsWith('/')) {
        if (filePath.startsWith(normalizedPattern)) return true;
      }
      // 通配符匹配
      else if (normalizedPattern.includes('*')) {
        const prefix = normalizedPattern.split('*')[0];
        if (filePath.startsWith(prefix)) return true;
      }
      // 精确匹配
      else if (filePath === normalizedPattern) {
        return true;
      }
    }
    return false;
  }

  /**
   * 规范化路径（展开 ~ 等）
   * @private
   */
  _normalizePath(filePath) {
    if (filePath.startsWith('~/') || filePath === '~') {
      return filePath.replace('~', process.env.HOME || '/tmp');
    }
    return filePath;
  }

  /**
   * 记录审计日志
   * @private
   */
  _audit(agentId, actionType, details, allowed) {
    const entry = {
      timestamp: new Date().toISOString(),
      agentId,
      actionType,
      details,
      allowed
    };

    this.auditLog.push(entry);
    if (this.auditLog.length > this.maxAuditLog) {
      this.auditLog.shift();
    }
  }
}

// ─── 单例 ────────────────────────────────────────────

const permissionGuard = new PermissionGuard();

// ─── CLI ─────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'check': {
      // node permission-guard.js check --agent silijian --action agent_call --target bingbu
      const agentId = args[args.indexOf('--agent') + 1];
      const actionType = args[args.indexOf('--action') + 1];
      const action = { type: actionType };

      if (actionType === 'agent_call') action.target = args[args.indexOf('--target') + 1];
      if (actionType === 'skill_exec') action.skill = args[args.indexOf('--skill') + 1];
      if (actionType === 'task_op') action.operation = args[args.indexOf('--op') + 1];
      if (actionType === 'file_access') {
        action.filePath = args[args.indexOf('--file') + 1];
        action.mode = args[args.indexOf('--mode') + 1] || 'read';
      }

      try {
        permissionGuard.intercept(agentId, action);
        console.log(`✅ 准奏：${agentId} 可执行 ${actionType}`);
      } catch (e) {
        console.error(`❌ ${e.message}`);
        process.exit(1);
      }
      break;
    }

    case 'summary': {
      // node permission-guard.js summary --agent bingbu
      const agentId = args[args.indexOf('--agent') + 1];
      console.log(JSON.stringify(permissionGuard.getPermissionSummary(agentId), null, 2));
      break;
    }

    case 'list': {
      // node permission-guard.js list
      console.log(JSON.stringify(permissionGuard.listPermissions(), null, 2));
      break;
    }

    case 'audit': {
      // node permission-guard.js audit [--limit 20]
      const limitIdx = args.indexOf('--limit');
      const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 50;
      console.log(JSON.stringify(permissionGuard.getAuditLog(limit), null, 2));
      break;
    }

    default:
      console.log(`门下省 — 权限拦截系统

用法：
  node permission-guard.js check --agent <id> --action <type> [options]
  node permission-guard.js summary --agent <id>
  node permission-guard.js list
  node permission-guard.js audit [--limit N]

操作类型 (--action):
  agent_call   --target <agent_id>
  skill_exec   --skill <skill_name>
  task_op      --op <create|update|cancel|read>
  file_access  --file <path> --mode <read|write>

示例：
  node permission-guard.js check --agent silijian --action agent_call --target bingbu
  node permission-guard.js check --agent hubu --action skill_exec --skill github
  node permission-guard.js summary --agent duchayuan`);
  }
}

module.exports = {
  PermissionGuard,
  permissionGuard,
  ActionType,
  TaskOperation,
  FileMode,
  DEFAULT_PERMISSIONS,
  HANLIN_DEFAULT_PERMISSIONS
};
