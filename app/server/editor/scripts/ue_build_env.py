import json
import os


def get_build_id():
    library = getattr(unreal, "UEVLibrary", None)
    getter = getattr(library, "get_build_id", None) if library else None
    if not callable(getter):
        return None
    try:
        return str(getter())
    except Exception:
        return None


def main():
    project_file = unreal.Paths.convert_relative_path_to_full(
        unreal.Paths.get_project_file_path()
    )
    project_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
    saved_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
    engine_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.engine_dir())
    project_name = os.path.basename(project_file).replace(".uproject", "")

    print(json.dumps({
        "project_file": project_file,
        "project_dir": project_dir,
        "saved_dir": saved_dir,
        "project_name": project_name,
        "engine_dir": engine_dir,
        "engine_version": str(unreal.SystemLibrary.get_engine_version()),
        "build_id": get_build_id(),
    }, indent=2))


if __name__ == "__main__":
    main()
