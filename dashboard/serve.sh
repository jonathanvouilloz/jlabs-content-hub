#!/bin/bash
cd "$(dirname "$0")"
echo "🚀 Dashboard disponible sur http://localhost:4242"
open http://localhost:4242
npx serve . -p 4242
