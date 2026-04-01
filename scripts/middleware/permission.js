/**
 * Permission Middleware - 门下省 Express 中间件
 *
 * @fileoverview 在 HTTP 请求层面拦截未授权操作
 *
 * @version 1.0.0
 * @author 门下省
 *
 * 用法：
 *   const express = require('express');
 *   const { requireAgent, createPermissionMiddleware } = require('./middleware/permission');
 *
 *   app.use(requireAgent());
 *   app.post('/api/agents/:target/call', createPermissionMiddleware('agent_call'));
 *   app.post('/api/skills/:skill/execute', createPermissionMiddleware('skill_exec'));
 */

const { permissionGuard, ActionType } = require('../permission-guard');
const { AppError, ErrorCode } = require('../error');
const log = require('../logger');

/**
 * 从请求中提取 Agent ID
 * 优先级：req.agentId > X-Agent-Id header > query param
 * @param {object} req - Express request
 * @returns {string|null}
 */
function extractAgentId(req) {
  return req.agentId
    || req.headers['x-agent-id']
    || req.query.agentId
    || null;
}

/**
 * 中间件：要求请求必须携带 Agent ID
 * @returns {Function} Express middleware
 */
function requireAgent() {
  return (req, res, next) => {
    const agentId = extractAgentId(req);
    if (!agentId) {
      const err = new AppError(
        ErrorCode.PERMISSION_DENIED,
        '[门下省] 未提供 Agent 身份（缺少 X-Agent-Id）',
        { path: req.path, method: req.method }
      );
      log.warn(`[Permission MW] Missing agent ID: ${req.method} ${req.path}`);
      return res.status(err.statusCode).json(err.toJSON());
    }
    req.agentId = agentId;
    next();
  };
}

/**
 * 创建特定操作类型的权限中间件
 *
 * @param {string} actionType - 操作类型 (agent_call / skill_exec / task_op / file_access)
 * @param {object} [options] - 配置选项
 * @param {Function} [options.extractAction] - 自定义操作提取函数 (req) => action details
 * @returns {Function} Express middleware
 */
function createPermissionMiddleware(actionType, options = {}) {
  return (req, res, next) => {
    const agentId = extractAgentId(req);
    if (!agentId) {
      const err = new AppError(
        ErrorCode.PERMISSION_DENIED,
        '[门下省] 未提供 Agent 身份',
        { path: req.path }
      );
      return res.status(err.statusCode).json(err.toJSON());
    }

    let action;

    // 自定义提取
    if (options.extractAction) {
      action = options.extractAction(req);
    } else {
      // 默认提取逻辑
      switch (actionType) {
        case ActionType.AGENT_CALL:
          action = {
            type: ActionType.AGENT_CALL,
            target: req.params.target || req.body.target
          };
          break;

        case ActionType.SKILL_EXEC:
          action = {
            type: ActionType.SKILL_EXEC,
            skill: req.params.skill || req.body.skill
          };
          break;

        case ActionType.TASK_OP:
          action = {
            type: ActionType.TASK_OP,
            operation: req.params.operation || req.body.operation || req.method.toLowerCase(),
            taskId: req.params.taskId || req.body.taskId
          };
          // Map HTTP methods to task operations
          if (action.operation === 'post') action.operation = 'create';
          if (action.operation === 'put' || action.operation === 'patch') action.operation = 'update';
          if (action.operation === 'delete') action.operation = 'cancel';
          if (action.operation === 'get') action.operation = 'read';
          break;

        case ActionType.FILE_ACCESS:
          action = {
            type: ActionType.FILE_ACCESS,
            filePath: req.params.filePath || req.body.filePath || req.query.path,
            mode: req.method === 'GET' ? 'read' : 'write'
          };
          break;

        default:
          return next(new AppError(
            ErrorCode.PERMISSION_DENIED,
            `[门下省] 未知操作类型: ${actionType}`
          ));
      }
    }

    try {
      permissionGuard.intercept(agentId, action);
      next();
    } catch (err) {
      if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
      }
      next(err);
    }
  };
}

/**
 * 通用权限检查中间件
 * 从 request body 中读取完整的 action 对象
 *
 * 用法：
 *   app.post('/api/permission/check', permissionCheckMiddleware());
 *   // body: { agentId: 'bingbu', action: { type: 'skill_exec', skill: 'github' } }
 *
 * @returns {Function} Express middleware
 */
function permissionCheckMiddleware() {
  return (req, res, next) => {
    const { agentId, action } = req.body;

    if (!agentId || !action) {
      return res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: '缺少 agentId 或 action'
        }
      });
    }

    try {
      permissionGuard.intercept(agentId, action);
      res.json({ allowed: true, agentId, action });
    } catch (err) {
      if (err instanceof AppError) {
        return res.status(err.statusCode).json({
          allowed: false,
          ...err.toJSON()
        });
      }
      next(err);
    }
  };
}

module.exports = {
  extractAgentId,
  requireAgent,
  createPermissionMiddleware,
  permissionCheckMiddleware
};
