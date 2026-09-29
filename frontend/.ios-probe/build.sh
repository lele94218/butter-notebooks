#!/bin/bash
# Rebuild the probe app after editing main.swift
set -e
cd "$(dirname "$0")"
SDK=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun -sdk iphonesimulator swiftc -target arm64-apple-ios17.0-simulator -sdk "$SDK" \
  main.swift -o BWK.app/BWK
echo "rebuilt BWK.app"
