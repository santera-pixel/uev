import json


def main():
    name = str(decode_template_json("""${name}""") or "").strip()
    raw_value = decode_template_json("""${value}""")
    if isinstance(raw_value, bool):
        text_value = "1" if raw_value else "0"
    else:
        text_value = str(raw_value)

    world = unreal.EditorLevelLibrary.get_editor_world()
    unreal.SystemLibrary.execute_console_command(world, f"{name} {text_value}")
    print(json.dumps({"success": True, "name": name, "value": text_value}, indent=2))


if __name__ == "__main__":
    main()
