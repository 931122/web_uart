#!/bin/bash
# Web UART Static Build Script

# Set error handling
set -e

echo "🚀 开始构建 Web UART 静态包..."

# Define directories
DIST_DIR="dist"

# Clean previous build
if [ -d "$DIST_DIR" ]; then
    echo "🧹 清理旧的 $DIST_DIR 目录..."
    rm -rf "$DIST_DIR"
fi

# Create dist directory
mkdir -p "$DIST_DIR"

# Copy files
echo "📦 正在复制静态资产到 $DIST_DIR 目录..."
cp index.html "$DIST_DIR/"
cp style.css "$DIST_DIR/"
cp app.js "$DIST_DIR/"

# Make sure index.html links relative paths correctly (which it already does!)
echo "✅ 构建成功！纯静态打包资产已生成至 $DIST_DIR/ 目录中。"
echo "💡 您可以直接将 $DIST_DIR 目录下的内容部署到 GitHub Pages、Gitee Pages 或任何静态托管服务器上！"
