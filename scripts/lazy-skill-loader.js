#!/usr/bin/env node
/**
 * Lazy Skill Loader - 延迟加载技能系统
 *
 * @fileoverview 按需加载 Skill，减少启动 token 消耗
 * - 启动时只扫描元数据，不加载代码
 * - 执行时才加载并初始化
 * - TTL 缓存淘汰：长期未用的 Skill 自动卸载
 * - 与 message-bus 集成，发布加载/执行/卸载事件
 *
 * @version 1.0.0
 * @author 工部
 *
 * 用法：
 *   const { lazySkillRegistry } = require('./lazy-skill-loader');
 *
 *   // 列出所有可用技能（不加载）
 *   lazySkillRegistry.listSkills();
 *
 *   // 按需执行（自动加载）
 *   await lazySkillRegistry.execute('github', context);
 *
 *   // 批量预加载常用技能
 *   await lazySkillRegistry.preload(['github', 'notion']);
 */

const fs = require('fs');
const path = require('path');
const { Skill, SkillResult } = require('./skill-base');
const { AppError, ErrorCode } = require('./error');
const log = require('./logger');
const { messageBus } = require('./message-bus');

// ─── 配置 ────────────────────────────────────────────

const DEFAULT_CONFIG = {
  /** 技能目录路径 */
  skillsPath: path.join(__dirname, '..', 'skills'),
  /** 缓存 TTL（ms），默认 30 分钟 */
  ttlMs: 30 * 60 * 1000,
  /** 自动清理间隔（ms），0 = 禁用 */
  cleanupIntervalMs: 5 * 60 * 1000,
  /** 最大同时加载数量 */
  maxLoaded: 20
};

// ─── 技能索引条目 ────────────────────────────────────

/**
 * @typedef {object} SkillIndexEntry
 * @property {string} name - 技能名称
 * @property {string} dir - 技能目录路径
 * @property {object} meta - 元数据 (_meta.json 内容)
 * @property {object} pkg - package.json 内容（如有）
 * @property {string|null} description - 描述
 * @property {string|null} version - 版本号
 * @property {string[]} tags - 标签（用于 Agent 匹配）
 * @property {boolean} loaded - 是否已加载
 */

// ─── Agent 角色到技能标签的映射 ──────────────────────

const AGENT_SKILL_TAGS = {
  silijian: ['*'],
  neige: ['analysis', 'planning', 'general'],
  bingbu: ['coding', 'github', 'browser', 'dev'],
  hubu: ['finance', 'data', 'notion', 'analysis'],
  libu: ['marketing', 'content', 'social', 'news'],
  gongbu: ['devops', 'github', 'infra', 'browser'],
  libu2: ['management', 'notion', 'planning'],
  xingbu: ['legal', 'compliance', 'security'],
  duchayuan: ['review', 'github', 'quality'],
  'hanlin_*': ['novel', 'writing', 'research']
};

// ─── LazySkillRegistry ───────────────────────────────

class LazySkillRegistry {
  /**
   * @param {object} [config]
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    /** @type {Map<string, SkillIndexEntry>} 技能索引 */
    this.index = new Map();
    /** @type {Map<string, { skill: Skill, lastUsedAt: number }>} 已加载缓存 */
    this.cache = new Map();
    /** @type {Map<string, { loads: number, executions: number, totalExecMs: number, errors: number }>} */
    this.stats = new Map();
    /** @type {NodeJS.Timeout|null} */
    this._cleanupTimer = null;

    // 扫描索引
    this._scanSkills();

    // 启动自动清理
    if (this.config.cleanupIntervalMs > 0) {
      this._startAutoCleanup();
    }
  }

  // ─── 公开方法 ──────────────────────────────────────

  /**
   * 列出所有可用技能（不加载代码）
   * @returns {SkillIndexEntry[]}
   */
  listSkills() {
    return Array.from(this.index.values()).map(entry => ({
      name: entry.name,
      description: entry.description,
      version: entry.version,
      tags: entry.tags,
      loaded: this.cache.has(entry.name)
    }));
  }

  /**
   * 按需加载技能
   * @param {string} name - 技能名称
   * @returns {Promise<Skill>}
   * @throws {AppError} AGENT_NOT_FOUND (skill not found)
   */
  async loadSkill(name) {
    // 已加载 → 更新时间戳并返回
    if (this.cache.has(name)) {
      const cached = this.cache.get(name);
      cached.lastUsedAt = Date.now();
      return cached.skill;
    }

    // 索引中查找
    const entry = this.index.get(name);
    if (!entry) {
      throw new AppError(
        ErrorCode.AGENT_NOT_FOUND,
        `技能不存在: ${name}`,
        { skillName: name, available: Array.from(this.index.keys()) }
      );
    }

    // 检查容量限制
    if (this.cache.size >= this.config.maxLoaded) {
      this._evictLeastRecentlyUsed();
    }

    // 加载
    const startMs = Date.now();
    try {
      const skill = await this._loadFromDisk(entry);
      this.cache.set(name, { skill, lastUsedAt: Date.now() });

      // 统计
      this._recordStat(name, 'loads');
      const loadMs = Date.now() - startMs;
      log.info(`[LazySkill] Loaded: ${name} (${loadMs}ms)`);
      messageBus.publish('skill.loaded', { name, loadMs });

      return skill;
    } catch (err) {
      this._recordStat(name, 'errors');
      log.error(`[LazySkill] Failed to load: ${name}`, { error: err.message });
      messageBus.publish('skill.error', { name, error: err.message, phase: 'load' });
      throw new AppError(
        ErrorCode.AGENT_EXECUTION_FAILED,
        `技能加载失败: ${name} — ${err.message}`,
        { skillName: name },
        err
      );
    }
  }

  /**
   * 执行技能（自动加载）
   * @param {string} name
   * @param {object} context
   * @returns {Promise<SkillResult>}
   */
  async execute(name, context) {
    const skill = await this.loadSkill(name);

    const startMs = Date.now();
    try {
      const result = await skill.execute(context);
      const execMs = Date.now() - startMs;

      this._recordStat(name, 'executions');
      this._addExecTime(name, execMs);

      log.info(`[LazySkill] Executed: ${name} (${execMs}ms, success: ${result.success})`);
      messageBus.publish('skill.executed', { name, execMs, success: result.success });

      return result;
    } catch (err) {
      this._recordStat(name, 'errors');
      log.error(`[LazySkill] Execution failed: ${name}`, { error: err.message });
      messageBus.publish('skill.error', { name, error: err.message, phase: 'execute' });

      return SkillResult.fail(err);
    }
  }

  /**
   * 卸载技能（释放内存）
   * @param {string} name
   */
  async unloadSkill(name) {
    const cached = this.cache.get(name);
    if (!cached) return;

    try {
      await cached.skill.destroy();
    } catch (err) {
      log.warn(`[LazySkill] Error destroying ${name}: ${err.message}`);
    }

    this.cache.delete(name);
    log.info(`[LazySkill] Unloaded: ${name}`);
    messageBus.publish('skill.unloaded', { name });
  }

  /**
   * 获取当前已加载的技能
   * @returns {Array<{ name: string, lastUsedAt: string }>}
   */
  getLoadedSkills() {
    return Array.from(this.cache.entries()).map(([name, entry]) => ({
      name,
      lastUsedAt: new Date(entry.lastUsedAt).toISOString()
    }));
  }

  /**
   * 批量预加载
   * @param {string[]} names
   * @returns {Promise<{ loaded: string[], failed: string[] }>}
   */
  async preload(names) {
    const loaded = [];
    const failed = [];

    await Promise.allSettled(
      names.map(async (name) => {
        try {
          await this.loadSkill(name);
          loaded.push(name);
        } catch {
          failed.push(name);
        }
      })
    );

    log.info(`[LazySkill] Preloaded: ${loaded.length} ok, ${failed.length} failed`);
    return { loaded, failed };
  }

  /**
   * 为特定 Agent 发现相关技能
   * @param {string} agentId
   * @returns {SkillIndexEntry[]}
   */
  discoverSkills(agentId) {
    const agentTags = this._getAgentTags(agentId);
    if (agentTags.includes('*')) {
      return this.listSkills();
    }

    return this.listSkills().filter(skill => {
      if (skill.tags.length === 0) return true; // 无标签 = 通用
      return skill.tags.some(tag => agentTags.includes(tag));
    });
  }

  /**
   * 清理过期缓存
   * @returns {string[]} 被清理的技能名称
   */
  cleanup() {
    const now = Date.now();
    const evicted = [];

    for (const [name, entry] of this.cache.entries()) {
      if (now - entry.lastUsedAt > this.config.ttlMs) {
        this.unloadSkill(name);
        evicted.push(name);
      }
    }

    if (evicted.length > 0) {
      log.info(`[LazySkill] Cleanup: evicted ${evicted.length} stale skills`, { evicted });
    }
    return evicted;
  }

  /**
   * 获取统计信息
   * @returns {object}
   */
  getStats() {
    const result = {};
    for (const [name, stat] of this.stats.entries()) {
      result[name] = {
        ...stat,
        avgExecMs: stat.executions > 0 ? Math.round(stat.totalExecMs / stat.executions) : 0
      };
    }
    return {
      totalIndexed: this.index.size,
      totalLoaded: this.cache.size,
      skills: result
    };
  }

  /**
   * 停止自动清理（用于关闭时）
   */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  // ─── 内部方法 ──────────────────────────────────────

  /**
   * 扫描技能目录，构建索引
   * @private
   */
  _scanSkills() {
    const skillsPath = this.config.skillsPath;
    if (!fs.existsSync(skillsPath)) {
      log.warn(`[LazySkill] Skills directory not found: ${skillsPath}`);
      return;
    }

    const dirs = fs.readdirSync(skillsPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of dirs) {
      const fullDir = path.join(skillsPath, dir);

      // 读取元数据
      let meta = {};
      const metaPath = path.join(fullDir, '_meta.json');
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
      }

      // 读取 package.json
      let pkg = {};
      const pkgPath = path.join(fullDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { /* ignore */ }
      }

      // 提取标签
      const tags = this._inferTags(dir, meta, pkg);

      this.index.set(dir, {
        name: dir,
        dir: fullDir,
        meta,
        pkg,
        description: pkg.description || meta.description || null,
        version: meta.version || pkg.version || null,
        tags
      });
    }

    log.info(`[LazySkill] Indexed ${this.index.size} skills from ${skillsPath}`);
  }

  /**
   * 从磁盘加载技能并初始化
   * @private
   */
  async _loadFromDisk(entry) {
    // 尝试多种入口文件
    const candidates = [
      path.join(entry.dir, 'index.js'),
      path.join(entry.dir, 'handler.js'),
      path.join(entry.dir, 'hooks', 'openclaw', 'handler.js'),
      path.join(entry.dir, (entry.pkg.main || 'index.js'))
    ];

    let entryFile = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        entryFile = c;
        break;
      }
    }

    if (!entryFile) {
      // 如果没有可执行入口，创建一个空壳 Skill
      const stub = new Skill();
      stub.name = entry.name;
      stub.version = entry.version || '0.0.0';
      stub.description = entry.description || `Skill: ${entry.name}`;
      await stub.init({});
      return stub;
    }

    const mod = require(entryFile);

    // 支持多种导出格式
    if (mod instanceof Skill) {
      await mod.init({});
      return mod;
    }
    if (mod.default && mod.default instanceof Skill) {
      await mod.default.init({});
      return mod.default;
    }
    if (typeof mod === 'function') {
      // 工厂函数
      const skill = new Skill();
      skill.name = entry.name;
      skill.execute = mod;
      await skill.init({});
      return skill;
    }
    if (typeof mod.execute === 'function') {
      const skill = new Skill();
      skill.name = entry.name;
      skill.execute = mod.execute.bind(mod);
      if (mod.init) skill.init = mod.init.bind(mod);
      if (mod.destroy) skill.destroy = mod.destroy.bind(mod);
      await skill.init({});
      return skill;
    }

    // 最后兜底：包装为 Skill
    const wrapper = new Skill();
    wrapper.name = entry.name;
    wrapper.description = `Loaded from ${entryFile}`;
    await wrapper.init({});
    return wrapper;
  }

  /**
   * 推断技能标签
   * @private
   */
  _inferTags(dirName, meta, pkg) {
    const tags = new Set();

    // 基于目录名推断
    if (dirName.startsWith('novel-')) tags.add('novel').add('writing');
    if (dirName.includes('github')) tags.add('coding').add('github').add('dev');
    if (dirName.includes('notion')) tags.add('data').add('management').add('notion');
    if (dirName.includes('browser')) tags.add('browser').add('dev');
    if (dirName.includes('weather')) tags.add('general');
    if (dirName.includes('hacker-news')) tags.add('news').add('social');
    if (dirName.includes('discord')) tags.add('social').add('security');
    if (dirName.includes('quadrants')) tags.add('analysis').add('planning');
    if (dirName.includes('self-improving')) tags.add('general');
    if (dirName.includes('openviking')) tags.add('general');

    // 从 package.json keywords 提取
    if (pkg.keywords && Array.isArray(pkg.keywords)) {
      pkg.keywords.forEach(k => tags.add(k));
    }

    // 从 meta tags 提取
    if (meta.tags && Array.isArray(meta.tags)) {
      meta.tags.forEach(t => tags.add(t));
    }

    return Array.from(tags);
  }

  /**
   * 获取 Agent 对应的技能标签
   * @private
   */
  _getAgentTags(agentId) {
    if (AGENT_SKILL_TAGS[agentId]) {
      return AGENT_SKILL_TAGS[agentId];
    }
    // 翰林院前缀匹配
    if (agentId.startsWith('hanlin_')) {
      return AGENT_SKILL_TAGS['hanlin_*'] || [];
    }
    // 未知 Agent — 返回 general
    return ['general'];
  }

  /**
   * 淘汰最久未使用的技能
   * @private
   */
  _evictLeastRecentlyUsed() {
    let oldest = null;
    let oldestTime = Infinity;

    for (const [name, entry] of this.cache.entries()) {
      if (entry.lastUsedAt < oldestTime) {
        oldest = name;
        oldestTime = entry.lastUsedAt;
      }
    }

    if (oldest) {
      this.unloadSkill(oldest);
      log.info(`[LazySkill] Evicted LRU: ${oldest}`);
    }
  }

  /**
   * 记录统计
   * @private
   */
  _recordStat(name, field) {
    if (!this.stats.has(name)) {
      this.stats.set(name, { loads: 0, executions: 0, totalExecMs: 0, errors: 0 });
    }
    this.stats.get(name)[field]++;
  }

  /**
   * 记录执行时间
   * @private
   */
  _addExecTime(name, ms) {
    if (this.stats.has(name)) {
      this.stats.get(name).totalExecMs += ms;
    }
  }

  /**
   * 启动自动清理
   * @private
   */
  _startAutoCleanup() {
    this._cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);

    // 不阻止进程退出
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref();
    }
  }
}

// ─── 单例 ────────────────────────────────────────────

const lazySkillRegistry = new LazySkillRegistry();

// ─── CLI ─────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'list': {
      const skills = lazySkillRegistry.listSkills();
      console.log(`已索引 ${skills.length} 个技能：\n`);
      for (const s of skills) {
        const status = s.loaded ? '✅ 已加载' : '💤 未加载';
        console.log(`  ${status}  ${s.name}${s.version ? ` (v${s.version})` : ''}`);
        if (s.description) console.log(`          ${s.description}`);
        if (s.tags.length) console.log(`          标签: ${s.tags.join(', ')}`);
      }
      break;
    }

    case 'discover': {
      // node lazy-skill-loader.js discover --agent bingbu
      const agentId = args[args.indexOf('--agent') + 1];
      const skills = lazySkillRegistry.discoverSkills(agentId);
      console.log(`${agentId} 可用技能 (${skills.length})：\n`);
      for (const s of skills) {
        console.log(`  ${s.name}${s.tags.length ? ` [${s.tags.join(', ')}]` : ''}`);
      }
      break;
    }

    case 'stats': {
      console.log(JSON.stringify(lazySkillRegistry.getStats(), null, 2));
      break;
    }

    case 'loaded': {
      const loaded = lazySkillRegistry.getLoadedSkills();
      if (loaded.length === 0) {
        console.log('当前无已加载技能');
      } else {
        console.log(`已加载 ${loaded.length} 个技能：`);
        for (const s of loaded) {
          console.log(`  ${s.name} (last used: ${s.lastUsedAt})`);
        }
      }
      break;
    }

    default:
      console.log(`延迟加载技能系统

用法：
  node lazy-skill-loader.js list                       列出所有已索引技能
  node lazy-skill-loader.js discover --agent <id>      发现 Agent 可用技能
  node lazy-skill-loader.js loaded                     查看当前已加载技能
  node lazy-skill-loader.js stats                      查看统计信息

示例：
  node lazy-skill-loader.js list
  node lazy-skill-loader.js discover --agent bingbu
  node lazy-skill-loader.js discover --agent hanlin_zhang`);
  }
}

module.exports = {
  LazySkillRegistry,
  lazySkillRegistry,
  AGENT_SKILL_TAGS
};
