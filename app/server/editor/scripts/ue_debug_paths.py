import json


def get_paths():
    project_file = unreal.Paths.get_project_file_path()
    project_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
    saved_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
    normalized_project_file = str(project_file or "").replace(chr(92), "/")
    project_name = normalized_project_file.split("/")[-1].replace(".uproject", "")
    return {
        "project_file": normalized_project_file,
        "project_dir": project_dir,
        "saved_dir": saved_dir,
        "project_name": project_name,
    }


def main():
    print(json.dumps(get_paths(), indent=2))


if __name__ == "__main__":
    main()
