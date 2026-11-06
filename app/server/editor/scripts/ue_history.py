import json


def run_history(mode):
    action = "REDO" if str(mode or "").strip().lower() == "redo" else "UNDO"
    method = "console"
    success = True
    message = ""

    try:
        if hasattr(unreal, "UEVLibrary"):
            method = "UEVLibrary"
            success = bool(unreal.UEVLibrary.undo() if action == "UNDO" else unreal.UEVLibrary.redo())
        else:
            world = unreal.EditorLevelLibrary.get_editor_world()
            unreal.SystemLibrary.execute_console_command(world, action)
    except Exception as error:
        success = False
        message = str(error)

    return {
        "success": success,
        "action": action.lower(),
        "method": method,
        "scope": "global_editor_undo_stack",
        "message": message,
        "note": "This uses the editor's global undo stack; manual edits may be interleaved.",
    }


def main():
    mode = decode_template_json("""${mode}""")
    print(json.dumps(run_history(mode), indent=2))


if __name__ == "__main__":
    main()
