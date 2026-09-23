#!/usr/bin/env python3
"""Pick the app's Xcode scheme (not a Pod/helper library) from `xcodebuild -list -json`.

Reads the JSON on stdin, prints the chosen scheme name on stdout. Order of preference:
  1. a scheme whose name exactly matches the app's .xcodeproj name (argv[1], optional)
  2. the first scheme that is not a known Pods/React/Expo helper
  3. the first scheme, as a last resort
"""
import sys
import json

HELPERS = (
    "Pods-", "React", "Expo", "EASClient", "hermes", "RCT",
    "glog", "RNCAsyncStorage", "Yoga", "fmt", "DoubleConversion",
    "RNReanimated", "RNScreens", "RNGestureHandler",
)


def main():
    data = json.load(sys.stdin)
    schemes = data.get("workspace", {}).get("schemes", [])
    if not schemes:
        sys.exit("no schemes found in xcodebuild -list output")

    proj = sys.argv[1] if len(sys.argv) > 1 else ""

    if proj:
        for s in schemes:
            if s == proj:
                print(s)
                return

    for s in schemes:
        if not s.startswith(HELPERS):
            print(s)
            return

    print(schemes[0])


if __name__ == "__main__":
    main()
