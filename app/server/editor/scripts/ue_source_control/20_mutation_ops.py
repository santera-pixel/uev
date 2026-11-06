def _run_file_operation(
    operation_name,
    method_names,
    single_key=None,
    multi_key=None,
    description_key=None,
    keep_checked_out_key=None,
):
    def _handler(args):
        helper, helper_name = _resolve_source_control_helper()
        payload = {
            "helper_class": helper_name,
            "operation": operation_name,
        }
        payload.update(_provider_snapshot(helper))

        call_args = []

        if single_key:
            file_value = str(args.get(single_key) or "").strip()
            if not file_value:
                return {"success": False, "message": "{0} is required".format(single_key)}
            payload["file"] = file_value
            call_args.append(file_value)

        if multi_key:
            files = _coerce_string_list(args.get(multi_key), multi_key)
            payload[multi_key] = files
            payload["count"] = len(files)
            call_args.append(files)

        if description_key:
            description = str(args.get(description_key) or "").strip()
            if not description:
                return {
                    "success": False,
                    "message": "{0} is required".format(description_key),
                }
            payload["description"] = description
            call_args.append(description)

        call_args.append(True)

        if keep_checked_out_key:
            keep_checked_out = bool(args.get(keep_checked_out_key, False))
            payload["keep_checked_out"] = keep_checked_out
            call_args.append(keep_checked_out)

        try:
            success = bool(_call_helper_method(helper, method_names, *call_args))
        except TypeError as exc:
            if not keep_checked_out_key or not call_args:
                raise

            message = str(exc)
            if "argument" not in message and "positional" not in message:
                raise

            success = bool(_call_helper_method(helper, method_names, *call_args[:-1]))
            payload["keep_checked_out_ignored"] = True
        payload["success"] = success
        if not success and "message" not in payload:
            payload["message"] = "{0} failed".format(operation_name)
        return _append_last_error(payload, helper)

    return _handler


def _revert_and_reload_packages(args):
    packages = _coerce_string_list(args.get("packages"), "packages")
    helper, helper_name = _resolve_source_control_helper()
    payload = {
        "helper_class": helper_name,
        "operation": "revert_and_reload_packages",
        "packages": packages,
        "count": len(packages),
        "revert_all": bool(args.get("revert_all", False)),
        "reload_world": bool(args.get("reload_world", False)),
    }
    payload.update(_provider_snapshot(helper))

    success = bool(
        _call_helper_method(
            helper,
            ("revert_and_reload_packages", "RevertAndReloadPackages"),
            packages,
            payload["revert_all"],
            payload["reload_world"],
        )
    )
    payload["success"] = success
    if not success:
        payload["message"] = "revert_and_reload_packages failed"
    return _append_last_error(payload, helper)
