import json
import os
import sys


def get_python_env():
    return {
        "python_version": sys.version,
        "python_executable": sys.executable,
        "python_path": sys.path[:40],
        "working_directory": os.getcwd(),
        "unreal_module": getattr(unreal, "__file__", None),
    }


def main():
    print(json.dumps(get_python_env(), indent=2))


if __name__ == "__main__":
    main()
