import json


def get_native_console_variable(variable_name):
    library = getattr(unreal, "UEVLibrary", None)
    getter = getattr(library, "get_console_variable_info", None) if library else None
    if not callable(getter):
        return None

    try:
        payload = getter(variable_name)
        if isinstance(payload, str):
            payload = json.loads(payload)
        if not isinstance(payload, dict):
            return None
        return {
            "available": bool(payload.get("available")),
            "string_value": str(payload.get("string_value") or ""),
            "float_value": float(payload.get("float_value") or 0.0),
            "int_value": int(payload.get("int_value") or 0),
            "bool_value": bool(payload.get("bool_value")),
            "help": str(payload.get("help") or ""),
        }
    except Exception as error:
        return {"available": False, "error": str(error), "native_error": True}


def read_console_variable(variable_name):
    normalized_name = str(variable_name or "").strip()
    if not normalized_name:
        return {"available": False, "error": "empty cvar name"}

    native = get_native_console_variable(normalized_name)
    if native is not None and not native.get("native_error"):
        return native

    try:
        float_value = unreal.SystemLibrary.get_console_variable_float_value(normalized_name)
        int_value = unreal.SystemLibrary.get_console_variable_int_value(normalized_name)
        bool_value = unreal.SystemLibrary.get_console_variable_bool_value(normalized_name)
        string_getter = getattr(unreal.SystemLibrary, "get_console_variable_string_value", None)
        string_value = ""
        if callable(string_getter):
            try:
                string_value = str(string_getter(normalized_name))
            except Exception:
                string_value = ""

        available = bool(string_value) or float_value != 0.0 or int_value != 0 or bool(bool_value)
        if not available and string_value == "0":
            available = True

        return {
            "available": available,
            "string_value": string_value,
            "float_value": float(float_value),
            "int_value": int(int_value),
            "bool_value": bool(bool_value),
        }
    except Exception as error:
        return {"available": False, "error": str(error)}


def main():
    names = decode_template_json("""${names}""")
    results = {}
    for name in names or []:
        results[str(name)] = read_console_variable(name)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
