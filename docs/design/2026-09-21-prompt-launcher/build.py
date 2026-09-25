"""兼容旧生成命令；现以 prompts.json 为源，不再依赖桌面 TXT。"""
from pathlib import Path
import subprocess
subprocess.run(['node', str(Path(__file__).with_name('build.cjs'))], check=True)