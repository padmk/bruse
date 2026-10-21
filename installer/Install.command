#!/bin/bash
# Double-click entry point on macOS: finds Node.js 22 or newer and runs the installer next to it.
cd "$(dirname "$0")" || exit 1

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null; }

NODE=""
for candidate in "$(command -v node)" /opt/homebrew/bin/node /opt/homebrew/opt/node@24/bin/node /opt/homebrew/opt/node@22/bin/node \
  /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/aliases/default/bin/node; do
  if [ -x "$candidate" ] && [ "$(node_major "$candidate")" -ge 22 ] 2>/dev/null; then NODE="$candidate"; break; fi
done

if [ -z "$NODE" ]; then
  echo "Node.js 22 or newer is required. Install it (for example: brew install node, or https://nodejs.org) and run this again."
  read -r -p "Press Return to close."
  exit 1
fi

# In the package the installer sits in installer/; in the source tree, next to this file.
SCRIPT=installer/install.mjs
[ -f "$SCRIPT" ] || SCRIPT=install.mjs
INSTALL_NODE="$NODE" "$NODE" "$SCRIPT"
status=$?
read -r -p "Press Return to close."
exit $status
