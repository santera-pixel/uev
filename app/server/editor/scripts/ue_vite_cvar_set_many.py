import json


def main():
    values = decode_template_json("""${values}""") or {}
    world = unreal.EditorLevelLibrary.get_editor_world()
    applied = {}

    for variable_name, raw_value in values.items():
        name = str(variable_name or "").strip()
        if not name:
            continue
        if isinstance(raw_value, bool):
            text_value = "1" if raw_value else "0"
        else:
            text_value = str(raw_value)
        unreal.SystemLibrary.execute_console_command(world, f"{name} {text_value}")
        applied[name] = text_value

    print(json.dumps({"success": True, "values": applied}, indent=2))


if __name__ == "__main__":
    main()
