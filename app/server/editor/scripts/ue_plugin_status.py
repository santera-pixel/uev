import json


def read_plugin_status():
    probes = decode_template_json("""${probes}""")
    module_names = decode_template_json("""${modules}""")

    available = []
    plugin_details = {}
    source = "python"

    if hasattr(unreal, "UEVLibrary") and hasattr(
        unreal.UEVLibrary, "get_enabled_plugin_names"
    ):
        try:
            source = "UEVLibrary"
            for name in unreal.UEVLibrary.get_enabled_plugin_names():
                text = str(name)
                if text:
                    available.append(text)
        except Exception as error:
            plugin_details["_mcp_history_error"] = str(error)

    for plugin_name, attributes in (probes or {}).items():
        name = str(plugin_name)
        if name == "PythonScriptPlugin":
            available.append(name)
            plugin_details[name] = {"available": True, "matches": ["transport"]}
            continue

        matches = []
        try:
            for attribute in attributes or []:
                if hasattr(unreal, str(attribute)):
                    matches.append(str(attribute))
        except Exception as error:
            plugin_details[name] = {"available": False, "matches": [], "error": str(error)}
            continue

        if matches:
            available.append(name)
        plugin_details[name] = {"available": bool(matches), "matches": matches}

    unique = []
    for name in available:
        if name not in unique:
            unique.append(name)
    unique.sort()

    module_details = {}
    for module_name in module_names or []:
        name = str(module_name)
        loaded = None
        if hasattr(unreal, "UEVLibrary") and hasattr(
            unreal.UEVLibrary, "is_module_loaded"
        ):
            try:
                loaded = bool(unreal.UEVLibrary.is_module_loaded(name))
            except Exception:
                loaded = None
        module_details[name] = loaded

    return {
        "source": source,
        "plugins": unique,
        "pluginDetails": plugin_details,
        "modules": module_details,
    }


def main():
    print(json.dumps(read_plugin_status(), indent=2))


if __name__ == "__main__":
    main()
