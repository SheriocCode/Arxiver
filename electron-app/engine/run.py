"""Bundled translation engine bootstrap for the Electron app.

Runs on the embedded interpreter ``engine/runtime/python.exe``. The engine source
(``translate_engine``) lives in the ``engine`` root and the third-party dependencies
live in ``engine/site-packages``; both are put on ``sys.path`` here (the embeddable
distribution uses a ``._pth`` file, so we cannot rely on the environment). It then
restores the offline assets (fonts, tiktoken cache) into babeldoc's
cache directory on first use, before handing the CLI arguments to the engine.
"""

import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "babeldoc")

SITE = os.path.join(HERE, "site-packages")
# 引擎源码在 engine 根目录（translate_engine/），第三方依赖在 site-packages/。
for _entry in (SITE, HERE):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)


def restore_assets():
    for sub in ("fonts", "tiktoken"):
        src = os.path.join(ASSETS, sub)
        if not os.path.isdir(src):
            continue
        dst = os.path.join(CACHE, sub)
        os.makedirs(dst, exist_ok=True)
        for name in os.listdir(src):
            source = os.path.join(src, name)
            if not os.path.isfile(source):
                continue
            target = os.path.join(dst, name)
            try:
                if os.path.isfile(target) and os.path.getsize(target) == os.path.getsize(source):
                    continue
                shutil.copy2(source, target)
            except OSError:
                pass


def main():
    restore_assets()
    from translate_engine.main import main as engine_main

    return engine_main(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
