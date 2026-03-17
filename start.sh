#!/bin/bash
# 启动脚本

# 停止并删除旧进程
pm2 delete dingtalk-bot 2>/dev/null

# 编译项目
echo "编译项目..."
npx tsc

# 启动 PM2
echo "启动 PM2..."
pm2 start ecosystem.config.js

# 显示状态
pm2 status