import json


def _has_class(name):
    return hasattr(unreal, name)


def compatibility(args=None):
    engine_version = ""
    try:
        engine_version = str(unreal.SystemLibrary.get_engine_version() or "")
    except Exception as exc:
        return {"success": False, "message": "Could not read engine version: {0}".format(exc)}

    project_file = ""
    try:
        project_file = str(unreal.Paths.get_project_file_path())
    except Exception:
        pass

    plugins = {
        "UEVGraphLibrary": _has_class("UEVGraphLibrary"),
        "UEVLibrary": _has_class("UEVLibrary"),
        "UEVReflectLibrary": _has_class("UEVReflectLibrary"),
    }

    capabilities = {
        "nested_blueprint_read": plugins["UEVGraphLibrary"],
        "component_setters": plugins["UEVGraphLibrary"],
        "material_short_names": plugins["UEVGraphLibrary"],
        "material_property_preview": plugins["UEVGraphLibrary"],
        "widget_bind_event": plugins["UEVGraphLibrary"],
        "widget_launch_editor_utility": _has_class("EditorUtilitySubsystem"),
        "reflect_export_text": plugins["UEVReflectLibrary"],
        "substrate": True,
    }

    return {
        "success": True,
        "engine": {
            "version_string": engine_version,
            "project_file": project_file,
        },
        "plugins": plugins,
        "capabilities": capabilities,
    }


_OPERATIONS = {
    "compatibility": compatibility,
}


def _run(operation, args):
    handler = _OPERATIONS.get(str(operation or ""))
    if handler is None:
        return {"success": False, "message": "Unknown compat operation: {0}".format(operation)}
    return handler(args or {})


def main():
    operation = decode_template_json("""${operation}""")
    args = decode_template_json("""${args}""")
    try:
        result = _run(operation, args)
    except Exception as exc:
        result = {"success": False, "message": str(exc)}
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
