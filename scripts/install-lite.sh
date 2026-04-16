#!/bin/bash

# ========================================
# AI 朝廷 · 快速安装脚本
# ========================================
# 支持：
# - 三种制度：明朝/唐朝/现代
# - 多种规模：1/3/5/9/11 Bot
# - 两个平台：飞书/Discord
# - LLM API 配置（智能复用已有 OpenClaw 配置）
# ========================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/install-common.sh"

echo -e "${BLUE}"
echo "========================================"
echo "   AI 朝廷 · 快速安装向导"
echo "========================================"
echo -e "${NC}"

# 确保依赖
check_jq

# 配置目录
CONFIG_DIR="$HOME/.openclaw"
CONFIG_FILE="openclaw.json"

# 创建配置目录
mkdir -p "$CONFIG_DIR"

# ========================================
# 步骤 1: 配置 LLM API（智能检测）
# ========================================
echo -e "${YELLOW}[1/5] 配置 AI 模型${NC}"
configure_llm

# ========================================
# 步骤 2: 选择平台
# ========================================
echo ""
echo -e "${YELLOW}[2/5] 选择部署平台${NC}"
echo "  1) 飞书 (中国大陆推荐)"
echo "  2) Discord (国际推荐)"
echo "  3) 纯 WebUI (不需要 Bot)"
echo ""
read -p "请选择 (1-3): " PLATFORM

case $PLATFORM in
    1)
        PLATFORM_NAME="feishu"
        echo -e "${GREEN}✓ 选择：飞书${NC}"
        ;;
    2)
        PLATFORM_NAME="discord"
        echo -e "${GREEN}✓ 选择：Discord${NC}"
        ;;
    3)
        PLATFORM_NAME="webui"
        echo -e "${GREEN}✓ 选择：纯 WebUI${NC}"
        ;;
    *)
        echo -e "${RED}✗ 无效选择，使用飞书${NC}"
        PLATFORM_NAME="feishu"
        ;;
esac

# ========================================
# 步骤 3: 选择制度
# ========================================
echo ""
echo -e "${YELLOW}[3/5] 选择制度${NC}"
echo "  1) 明朝内阁制 (传统层级管理)"
echo "  2) 唐朝三省制 (分权制衡管理)"
echo "  3) 现代企业制 (现代企业管理)"
echo ""
read -p "请选择 (1-3): " REGIME

case $REGIME in
    1)
        REGIME_NAME="ming"
        REGIME_LABEL="明朝内阁制"
        ;;
    2)
        REGIME_NAME="tang"
        REGIME_LABEL="唐朝三省制"
        ;;
    3)
        REGIME_NAME="modern"
        REGIME_LABEL="现代企业制"
        ;;
    *)
        echo -e "${RED}✗ 无效选择，使用明朝内阁制${NC}"
        REGIME_NAME="ming"
        REGIME_LABEL="明朝内阁制"
        ;;
esac
echo -e "${GREEN}✓ 选择：$REGIME_LABEL${NC}"

# ========================================
# 步骤 4: 选择 Bot 数量
# ========================================
echo ""
echo -e "${YELLOW}[4/5] 选择 Bot 数量${NC}"

if [ "$PLATFORM_NAME" = "webui" ]; then
    echo "  WebUI 模式使用单 Agent"
    BOT_CHOICE="1"
else
    # 根据制度显示不同选项
    if [ "$REGIME_NAME" = "ming" ]; then
        echo "  1) 1 Bot - 司礼监 (个人开发者)"
        echo "  2) 3 Bot - 司礼监 + 内阁 + 工部 (小团队⭐推荐)"
        echo "  3) 5 Bot - 司礼监 + 内阁 + 都察院 + 兵部 + 工部 (中型团队)"
        echo "  4) 9 Bot - 完整版 (大型团队)"
    elif [ "$REGIME_NAME" = "tang" ]; then
        echo "  1) 1 Bot - 中书省 (个人开发者)"
        echo "  2) 3 Bot - 中书省 + 门下省 + 尚书省 (小团队⭐推荐)"
        echo "  3) 11 Bot - 完整版 (大型团队)"
    else
        echo "  1) 1 Bot - CEO (个人开发者)"
        echo "  2) 3 Bot - CEO + CTO + QA (小团队⭐推荐)"
        echo "  3) 9 Bot - 完整版 (大型团队)"
    fi
    echo ""
    read -p "请选择：" BOT_CHOICE
fi

# 根据制度和选择确定配置文件
if [ "$REGIME_NAME" = "ming" ]; then
    case $BOT_CHOICE in
        1) CONFIG_TEMPLATE="openclaw-1bot.json" ;;
        2) CONFIG_TEMPLATE="openclaw-3bot.json" ;;
        3) CONFIG_TEMPLATE="openclaw-5bot.json" ;;
        *) CONFIG_TEMPLATE="openclaw.json" ;;
    esac
elif [ "$REGIME_NAME" = "tang" ]; then
    case $BOT_CHOICE in
        1) CONFIG_TEMPLATE="openclaw-1bot.json" ;;
        2) CONFIG_TEMPLATE="openclaw-3bot.json" ;;
        *) CONFIG_TEMPLATE="openclaw.json" ;;
    esac
else
    case $BOT_CHOICE in
        1) CONFIG_TEMPLATE="openclaw-1bot.json" ;;
        2) CONFIG_TEMPLATE="openclaw-3bot.json" ;;
        *) CONFIG_TEMPLATE="openclaw.json" ;;
    esac
fi

# 定位仓库目录（支持本地运行和 curl 远程运行）
REPO_DIR="$HOME/clawd/danghuangshang"
if [ ! -d "$REPO_DIR" ]; then
    # 尝试从脚本位置推断
    _PARENT="$(cd "$SCRIPT_DIR/.." && pwd)"
    if [ -f "$_PARENT/configs/feishu-ming/openclaw.json" ]; then
        REPO_DIR="$_PARENT"
    fi
fi

CONFIG_SOURCE="$REPO_DIR/configs/feishu-$REGIME_NAME/$CONFIG_TEMPLATE"

echo -e "${GREEN}✓ 配置模板：$CONFIG_TEMPLATE${NC}"

# ========================================
# 步骤 5: 收集平台凭证
# ========================================
echo ""
echo -e "${YELLOW}[5/5] 收集平台凭证${NC}"

if [ "$PLATFORM_NAME" = "feishu" ]; then
    echo ""
    echo "请前往飞书开放平台创建应用："
    echo "https://open.feishu.cn/app"
    echo ""
    read -p "App ID: " APP_ID
    read -s -p "App Secret: " APP_SECRET
    echo ""

    if [ -z "$APP_ID" ] || [ -z "$APP_SECRET" ]; then
        echo -e "${RED}✗ 飞书凭证不能为空${NC}"
        exit 1
    fi

elif [ "$PLATFORM_NAME" = "discord" ]; then
    echo ""
    echo "请前往 Discord Developer Portal 创建 Bot："
    echo "https://discord.com/developers/applications"
    echo ""
    read -p "Bot Token: " BOT_TOKEN
    read -p "Server ID (Guild ID, 留空则所有服务器生效): " GUILD_ID
    echo ""

    if [ -z "$BOT_TOKEN" ]; then
        echo -e "${RED}✗ Bot Token 不能为空${NC}"
        exit 1
    fi

elif [ "$PLATFORM_NAME" = "webui" ]; then
    echo -e "${GREEN}✓ WebUI 模式不需要额外凭证${NC}"
    APP_ID=""
    APP_SECRET=""
    BOT_TOKEN=""
    GUILD_ID=""
fi

# ========================================
# 生成配置文件
# ========================================
echo ""
echo -e "${CYAN}⚙️  生成配置文件...${NC}"

if [ -f "$CONFIG_SOURCE" ]; then
    cp "$CONFIG_SOURCE" "$CONFIG_DIR/$CONFIG_FILE"

    # 替换平台凭证（sed 处理占位符）
    sed -i "s/YOUR_FEISHU_APP_ID/$APP_ID/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
    sed -i "s/YOUR_FEISHU_APP_SECRET/$APP_SECRET/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
    sed -i "s/YOUR_SILIJIAN_APP_ID/$APP_ID/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
    sed -i "s/YOUR_SILIJIAN_APP_SECRET/$APP_SECRET/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
    sed -i "s/YOUR_NEIGE_APP_ID/$APP_ID/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
    sed -i "s/YOUR_NEIGE_APP_SECRET/$APP_SECRET/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
    sed -i "s/YOUR_GONGBU_APP_ID/$APP_ID/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
    sed -i "s/YOUR_GONGBU_APP_SECRET/$APP_SECRET/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true

    # 替换 Discord 凭证
    sed -i "s/YOUR_DISCORD_BOT_TOKEN/$BOT_TOKEN/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
    sed -i "s/YOUR_GUILD_ID/${GUILD_ID:-}/g" "$CONFIG_DIR/$CONFIG_FILE" 2>/dev/null || true
else
    echo -e "${YELLOW}⚠ 配置模板不存在，创建基础配置${NC}"
    cat > "$CONFIG_DIR/$CONFIG_FILE" << EOF
{
  "models": {
    "providers": {
      "your-provider": {
        "baseUrl": "${LLM_API_URL:-}",
        "apiKey": "${LLM_API_KEY:-}",
        "api": "${LLM_API_FORMAT:-openai-completions}",
        "models": [{"id": "${LLM_MODEL_ID:-}", "name": "主模型"}]
      }
    }
  },
  "channels": {
    "feishu": {
      "enabled": $([ "$PLATFORM_NAME" = "feishu" ] && echo "true" || echo "false"),
      "accounts": {
        "silijian": {
          "appId": "$APP_ID",
          "appSecret": "$APP_SECRET",
          "name": "司礼监",
          "groupPolicy": "open"
        }
      }
    },
    "discord": {
      "enabled": $([ "$PLATFORM_NAME" = "discord" ] && echo "true" || echo "false"),
      "accounts": {
        "silijian": {
          "token": "$BOT_TOKEN",
          "name": "司礼监",
          "groupPolicy": "open"
        }
      }
    }
  },
  "gateway": {
    "mode": "local"
  }
}
EOF
fi

# 注入 LLM 配置（仅手动输入时；复用模式下模板保持原样）
if [ "$REUSE_MODELS" = "false" ] && [ -n "$LLM_API_URL" ]; then
    inject_llm_config "$CONFIG_DIR/$CONFIG_FILE"
fi

# ========================================
# 完成
# ========================================
echo ""
echo -e "${GREEN}========================================"
echo "   安装完成！"
echo "========================================${NC}"
echo ""
echo "📋 配置信息:"
echo "  平台：$PLATFORM_NAME"
echo "  制度：$REGIME_LABEL"
echo "  配置：$CONFIG_TEMPLATE"
if [ "$REUSE_MODELS" = "true" ]; then
    echo "  模型：(复用已有配置)"
elif [ -n "$LLM_MODEL_ID" ]; then
    echo "  模型：$LLM_MODEL_ID"
fi
echo ""
echo "🚀 下一步:"
echo "  1. 检查配置：cat $CONFIG_DIR/$CONFIG_FILE"
echo "  2. 启动服务：openclaw gateway start"
echo "  3. 查看状态：openclaw status"
echo ""
echo "📖 文档:"
echo "  https://github.com/wanikua/danghuangshang"
echo ""
