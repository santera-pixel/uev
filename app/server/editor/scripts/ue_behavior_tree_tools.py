"""UEV behavior tree graph authoring bridge.

Every bt_* operation is executed by the native UEVGraphAuthoring module through
unreal.UEVGraphAI.execute_ai_operation, which owns the transaction, the runtime
tree mutation, and the editor graph mirror in a single call.
"""

import json


UNAVAILABLE_MESSAGE = (
    "The native UEVGraphAI behavior tree helper is not loaded. Behavior tree graph "
    "authoring requires the UEVGraphAuthoring module from UEV 1.7.0; rebuild the native "
    "plugins against the UE Vite fork, restart the editor and run this operation again."
)


def main():
    operation = decode_template_json("""${operation}""")
    args = decode_template_json("""${args}""")

    helper = getattr(unreal, "UEVGraphAI", None)
    if helper is None:
        print(
            json.dumps(
                {"success": False, "code": "plugin.unavailable", "message": UNAVAILABLE_MESSAGE},
                indent=2,
            )
        )
        return

    if not hasattr(helper, "execute_ai_operation"):
        print(
            json.dumps(
                {
                    "success": False,
                    "code": "plugin.unavailable",
                    "message": (
                        "UEVGraphAI is loaded but does not expose execute_ai_operation. "
                        "Rebuild the UEVGraphAuthoring module from UEV 1.7.0 or newer."
                    ),
                },
                indent=2,
            )
        )
        return

    try:
        result = helper.execute_ai_operation(str(operation), json.dumps(args or {}))
        print(str(result))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, indent=2))


if __name__ == "__main__":
    main()
