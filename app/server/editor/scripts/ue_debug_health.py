import json
import sys


def get_health():
    project_file = unreal.Paths.get_project_file_path()
    project_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
    saved_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
    world_name = None
    try:
        world = unreal.EditorLevelLibrary.get_editor_world()
        world_name = world.get_name() if world else None
    except Exception:
        world_name = None

    return {
        "python_version": sys.version,
        "python_executable": sys.executable,
        "engine_version": unreal.SystemLibrary.get_engine_version(),
        "project_file": project_file,
        "project_dir": project_dir,
        "saved_dir": saved_dir,
        "world": world_name,
        "unreal_module": getattr(unreal, "__file__", None),
    }


def main():
    print(json.dumps(get_health(), indent=2))


if __name__ == "__main__":
    main()
