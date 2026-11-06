import json


def main():
    operation = decode_template_json("""${operation}""")
    args = decode_template_json("""${args}""")

    if not hasattr(unreal, "UEVGraphLibrary"):
        print(
            json.dumps(
                {
                    "success": False,
                    "code": "plugin.unavailable",
                    "message": "UEVGraphAuthoring is not loaded. Rebuild the UEVNative plugin with the UE Vite fork.",
                },
                indent=2,
            )
        )
        return

    try:
        result = unreal.UEVGraphLibrary.execute_graph_operation(
            str(operation), json.dumps(args or {})
        )
        print(str(result))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, indent=2))


if __name__ == "__main__":
    main()
