import json
import os
import re
import time

_LOG_TAIL_BYTES = 512 * 1024
_LOG_TAIL_LINES = 400
_MAX_CONDITIONS = 16
_LOG_PREFIX = re.compile(r"^\[\d{4}\.\d{2}\.\d{2}-[\d.:]+\]\[\s*\d+\]")


# ---------------------------------------------------------------------------
# Editor log helpers
#
# UE4.27 exposes no native console-output capture: USystemLibrary::
# ExecuteConsoleCommand runs GEngine->Exec without an output device, so output
# only reaches the editor log. Everything below reads Saved/Logs/*.log instead
# of pretending an output device exists.
# ---------------------------------------------------------------------------


def _full_path(candidate_path):
    text = str(candidate_path or "").strip()
    if not text:
        return ""

    try:
        return unreal.Paths.convert_relative_path_to_full(text)
    except Exception:
        return text


def _project_log_dir():
    log_dir = ""
    try:
        if hasattr(unreal.Paths, "project_log_dir"):
            log_dir = unreal.Paths.project_log_dir()
    except Exception:
        log_dir = ""

    if not log_dir:
        try:
            saved_dir = unreal.Paths.convert_relative_path_to_full(
                unreal.Paths.project_saved_dir()
            )
            log_dir = os.path.join(saved_dir, "Logs")
        except Exception:
            return ""

    return _full_path(log_dir)


def _find_log_file(explicit_path=None):
    if explicit_path:
        candidate = _full_path(explicit_path)
        return candidate if os.path.isfile(candidate) else ""

    log_dir = _project_log_dir()
    if not log_dir or not os.path.isdir(log_dir):
        return ""

    candidates = []
    try:
        for file_name in os.listdir(log_dir):
            if not file_name.lower().endswith(".log"):
                continue
            full_path = os.path.join(log_dir, file_name)
            try:
                candidates.append((os.path.getmtime(full_path), full_path))
            except OSError:
                continue
    except OSError:
        return ""

    if not candidates:
        return ""

    candidates.sort()
    return candidates[-1][1]


def _log_size(log_path):
    try:
        return os.path.getsize(log_path)
    except OSError:
        return 0


def _read_log_chunk(log_path, start_offset):
    """Read log text written since start_offset and report the byte window used."""
    if not log_path:
        return "", 0, 0

    try:
        size = os.path.getsize(log_path)
    except OSError:
        return "", 0, 0

    offset = int(start_offset) if isinstance(start_offset, (int, float)) else -1
    if offset < 0 or offset > size:
        # No usable baseline: fall back to a bounded tail window.
        offset = max(0, size - _LOG_TAIL_BYTES)

    read_size = min(size - offset, _LOG_TAIL_BYTES)
    try:
        with open(log_path, "rb") as handle:
            handle.seek(offset)
            raw = handle.read(max(0, read_size))
    except OSError:
        return "", offset, offset

    return raw.decode("utf-8", errors="replace"), offset, size


def _log_lines(text, max_lines=_LOG_TAIL_LINES, strip_prefix=True):
    lines = []
    for raw_line in str(text or "").splitlines():
        line = raw_line.rstrip("\r")
        if not line.strip():
            continue
        if strip_prefix:
            line = _LOG_PREFIX.sub("", line).strip()
        if line:
            lines.append(line)

    if len(lines) > max_lines:
        return lines[-max_lines:]
    return lines


# ---------------------------------------------------------------------------
# Console commands and console variables
# ---------------------------------------------------------------------------


def console_command(args):
    command = str(args.get("command") or "").strip()
    if not command:
        return {"success": False, "message": "command is required"}

    executor = getattr(unreal.SystemLibrary, "execute_console_command", None)
    if not callable(executor):
        return {
            "success": False,
            "command": command,
            "message": "unreal.SystemLibrary.execute_console_command is not exposed in this editor build.",
        }

    log_path = _find_log_file(args.get("log_path"))
    start_offset = _log_size(log_path)

    try:
        executor(None, command)
    except Exception as exc:
        return {
            "success": False,
            "command": command,
            "message": str(exc),
            "log_path": log_path or None,
        }

    text = ""
    start = start_offset
    end = start_offset
    # Console output is flushed synchronously, but the log device may still be
    # mid-write. Poll a few times with short bounded sleeps instead of guessing.
    for attempt in range(4):
        text, start, end = _read_log_chunk(log_path, start_offset)
        if text.strip():
            break
        if attempt < 3:
            time.sleep(0.03)

    lines = _log_lines(text)
    captured = bool(lines)
    warnings = []

    if not log_path:
        warnings.append(
            "No editor log file was found under Saved/Logs, so console output cannot be captured."
        )
    elif not captured:
        warnings.append(
            "The command produced no new editor log output. Many console commands change state without logging anything; this is not proof the command failed."
        )

    result = {
        "success": True,
        "command": command,
        "output_captured": captured,
        "output": "\n".join(lines),
        "output_line_count": len(lines),
        "log_path": log_path or None,
        "log_start_offset": start,
        "log_end_offset": end,
        "capture_method": "editor_log_tail",
        "warnings": warnings,
    }

    if not captured:
        result["note"] = (
            "Unreal console command output is not captured by this tool. "
            "Use manage_editor.run_python when Python stdout is required."
        )

    return result


def get_console_variable(args):
    variable_name = str(
        args.get("variable_name")
        or args.get("name")
        or args.get("console_variable")
        or ""
    ).strip()
    if not variable_name:
        return {"success": False, "message": "variable_name is required"}

    system_library = unreal.SystemLibrary
    warnings = []

    try:
        float_value = float(
            system_library.get_console_variable_float_value(variable_name)
        )
    except Exception as exc:
        return {
            "success": False,
            "variable_name": variable_name,
            "message": "Console variable lookup failed: {0}".format(exc),
        }

    try:
        int_value = int(system_library.get_console_variable_int_value(variable_name))
    except Exception:
        int_value = int(float_value)

    try:
        bool_value = bool(system_library.get_console_variable_bool_value(variable_name))
    except Exception:
        bool_value = bool(float_value)

    string_getter = getattr(
        system_library, "get_console_variable_string_value", None
    )
    string_value = ""
    if callable(string_getter):
        try:
            string_value = str(string_getter(variable_name))
        except Exception as exc:
            warnings.append(
                "get_console_variable_string_value failed ({0}); value derived from the numeric getters.".format(
                    exc
                )
            )
    else:
        warnings.append(
            "SystemLibrary.get_console_variable_string_value is not exposed in this editor build; string_value is derived from the numeric getters."
        )

    if not string_value:
        string_value = str(int_value if float_value == 0.0 else float_value)

    result = {
        "success": True,
        "variable_name": variable_name,
        "string_value": string_value,
        "float_value": float_value,
        "int_value": int_value,
        "bool_value": bool_value,
        "output_captured": False,
        "output": "",
        "capture_method": "none",
        "warnings": warnings,
        "note": "Canvas/console output is not produced by the console-variable getters; the values above come from SystemLibrary getters.",
    }

    # Opt-in only: executing the variable name prints its value into the editor
    # log, but the same call would execute a console *command*. Never do that by
    # default.
    if bool(args.get("execute_for_output")):
        capture = console_command(
            {"command": variable_name, "log_path": args.get("log_path")}
        )
        result["output"] = capture.get("output") or ""
        result["output_captured"] = bool(capture.get("output_captured"))
        result["capture_method"] = capture.get("capture_method")
        result["output_line_count"] = capture.get("output_line_count")
        result["log_path"] = capture.get("log_path")
        result["log_start_offset"] = capture.get("log_start_offset")
        result["log_end_offset"] = capture.get("log_end_offset")
        if capture.get("warnings"):
            result["warnings"].extend(capture.get("warnings") or [])
        if not result["output_captured"]:
            result["warnings"].append(
                "execute_for_output was requested but no log output was captured."
            )

    return result


# ---------------------------------------------------------------------------
# Asset editor tabs
# ---------------------------------------------------------------------------


def _asset_editor_subsystem():
    subsystem_class = getattr(unreal, "AssetEditorSubsystem", None)
    if subsystem_class is None:
        return None, "unreal.AssetEditorSubsystem is not exposed in this editor build."

    try:
        subsystem = unreal.get_editor_subsystem(subsystem_class)
    except Exception as exc:
        return None, "AssetEditorSubsystem is unavailable: {0}".format(exc)

    if not subsystem:
        return None, "AssetEditorSubsystem is unavailable."

    return subsystem, ""


def _edited_assets(subsystem):
    for method_name in ("get_all_edited_assets", "get_edited_assets"):
        method = getattr(subsystem, method_name, None)
        if not callable(method):
            continue
        try:
            return list(method())
        except Exception:
            return None
    return None


def _asset_path_of(asset):
    if asset is None:
        return ""
    try:
        value = str(asset.get_path_name())
        if value:
            return value
    except Exception:
        pass
    try:
        return str(asset.get_name())
    except Exception:
        return ""


def _asset_record(asset):
    return {
        "asset_path": _asset_path_of(asset),
        "asset_name": get_object_name(asset),
        "class_name": get_object_class_name(asset),
    }


def _edited_asset_paths(subsystem):
    assets = _edited_assets(subsystem)
    if assets is None:
        return None
    paths = []
    for asset in assets:
        path = _asset_path_of(asset).lower()
        if path:
            paths.append(path)
    return paths


def _is_asset_open(subsystem, asset):
    paths = _edited_asset_paths(subsystem)
    if paths is None:
        return None
    path = _asset_path_of(asset).lower()
    return bool(path) and path in paths


def _package_path(value):
    text = str(value or "").strip()
    if not text:
        return ""
    dot = text.find(".")
    return text[:dot] if dot > 0 else text


def _tracking_path():
    try:
        saved = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
    except Exception:
        saved = os.path.join(_full_path(unreal.Paths.project_dir()), "Saved")
    return os.path.join(saved, "UEV", "tracked-open-assets.json")


def _read_tracking():
    path = _tracking_path()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return []
    entries = payload.get("assets") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return []
    cleaned = []
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        package = _package_path(entry.get("asset_path"))
        key = package.lower()
        if not package or key in seen:
            continue
        seen.add(key)
        cleaned.append(
            {
                "asset_path": package,
                "opened_at": entry.get("opened_at"),
                "source": entry.get("source") or "mcp",
            }
        )
    return cleaned


def _write_tracking(entries):
    path = _tracking_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"assets": entries}, handle, indent=2)
    except OSError as exc:
        raise RuntimeError("Could not write {0}: {1}".format(path, exc))


def _track_open(asset_path, source):
    package = _package_path(asset_path)
    if not package:
        return
    entries = [entry for entry in _read_tracking() if _package_path(entry["asset_path"]).lower() != package.lower()]
    entries.append(
        {
            "asset_path": package,
            "opened_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": source,
        }
    )
    _write_tracking(entries)


def _untrack_open(asset_path):
    package = _package_path(asset_path).lower()
    entries = [entry for entry in _read_tracking() if _package_path(entry["asset_path"]).lower() != package]
    _write_tracking(entries)


def _tracked_asset_records():
    records = []
    for entry in _read_tracking():
        package = entry["asset_path"]
        exists = True
        try:
            exists = bool(unreal.EditorAssetLibrary.does_asset_exist(package))
        except Exception:
            exists = True
        if not exists:
            continue
        records.append(
            {
                "asset_path": package,
                "asset_name": package.rsplit("/", 1)[-1],
                "class_name": "",
                "opened_at": entry.get("opened_at"),
                "source": entry.get("source") or "mcp",
            }
        )
    records.sort(key=lambda record: record["asset_path"].lower())
    return records


def _open_asset_editor(subsystem, asset):
    errors = []
    for method_name in ("open_editor_for_asset", "open_editor_for_assets"):
        method = getattr(subsystem, method_name, None)
        if not callable(method):
            continue
        try:
            if method_name.endswith("_assets"):
                method([asset])
            else:
                method(asset)
            return method_name, errors
        except Exception as exc:
            errors.append("{0}: {1}".format(method_name, exc))

    try:
        asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
        open_editor = getattr(asset_tools, "open_editor_for_asset", None)
        if callable(open_editor):
            open_editor(asset)
            return "AssetTools.open_editor_for_asset", errors
        errors.append("AssetTools.open_editor_for_asset is not exposed")
    except Exception as exc:
        errors.append("AssetTools: {0}".format(exc))

    return "", errors


def _load_tab_asset(args):
    asset_path = str(args.get("asset_path") or args.get("path") or "").strip()
    if not asset_path:
        raise ValueError("asset_path is required")
    return asset_path, load_asset_by_identifier(asset_path)


def _asset_exists(asset_path):
    package = _package_path(asset_path)
    if not package:
        return False
    try:
        return bool(unreal.EditorAssetLibrary.does_asset_exist(package))
    except Exception:
        return True


def open_asset(args):
    asset_path, asset = _load_tab_asset(args)
    if asset is None or not _asset_exists(asset_path):
        return {
            "success": False,
            "reason": "not_found",
            "asset_path": asset_path,
            "opened": False,
            "message": "Asset not found: {0}".format(asset_path),
        }
    subsystem, error = _asset_editor_subsystem()
    if subsystem is None:
        return {
            "success": False,
            "asset_path": asset_path,
            "opened": False,
            "message": error,
        }

    already_open = _is_asset_open(subsystem, asset)
    method_name, errors = _open_asset_editor(subsystem, asset)
    if not method_name:
        return {
            "success": False,
            "asset_path": asset_path,
            "opened": False,
            "already_open": already_open,
            "message": "No asset editor open function is exposed in this editor build.",
            "errors": errors,
        }

    verified = _is_asset_open(subsystem, asset)
    warnings = []
    if verified is False:
        warnings.append(
            "The editor did not report the asset as edited after opening; the tab may still be loading."
        )
    if errors:
        warnings.extend(errors)

    result = {
        "success": True,
        "asset_path": asset_path,
        "opened": True,
        "method": method_name,
        "already_open": bool(already_open),
        "verified": verified,
        "handle": _asset_record(asset),
        "warnings": warnings,
    }
    if verified is None:
        result["warnings"].append(
            "AssetEditorSubsystem does not expose GetEditedAssets in this build; open state cannot be verified."
        )
    try:
        _track_open(asset_path, "open_asset")
        result["tracked"] = True
    except Exception as exc:
        result["tracked"] = False
        result["warnings"].append("Open state could not be tracked: {0}".format(exc))
    if args.get("focus"):
        focus_method, focus_errors = _open_asset_editor(subsystem, asset)
        result["focused"] = bool(focus_method) and _is_asset_open(subsystem, asset) is True
        if not focus_method:
            result["warnings"].append(
                "Focus after open failed: no asset editor focus/open function is exposed in this editor build."
            )
        if focus_errors:
            result["warnings"].extend(focus_errors)
        if not result["focused"]:
            result["warnings"].append(
                "The editor did not confirm focus after opening; the tab may not be active."
            )
    return result


def close_asset(args):
    asset_path, asset = _load_tab_asset(args)
    if asset is None:
        return {
            "success": False,
            "reason": "not_found",
            "asset_path": asset_path,
            "closed": False,
            "message": "Asset not found: {0}".format(asset_path),
        }
    subsystem, error = _asset_editor_subsystem()
    if subsystem is None:
        return {
            "success": False,
            "asset_path": asset_path,
            "closed": False,
            "message": error,
        }

    closer = getattr(subsystem, "close_all_editors_for_asset", None)
    if not callable(closer):
        return {
            "success": False,
            "asset_path": asset_path,
            "closed": False,
            "message": "AssetEditorSubsystem.close_all_editors_for_asset is not exposed in this editor build.",
        }

    was_open = _is_asset_open(subsystem, asset)
    try:
        close_result = closer(asset)
    except Exception as exc:
        return {
            "success": False,
            "asset_path": asset_path,
            "closed": False,
            "message": str(exc),
        }

    closed_count = 0
    if isinstance(close_result, bool):
        closed_count = 1 if close_result else 0
    elif isinstance(close_result, (int, float)):
        closed_count = int(close_result)

    verified = _is_asset_open(subsystem, asset)
    warnings = []
    if verified is None:
        warnings.append(
            "AssetEditorSubsystem does not expose GetEditedAssets in this build; closed state cannot be verified."
        )

    try:
        _untrack_open(asset_path)
        tracked = True
    except Exception as exc:
        tracked = False
        warnings.append("Open state could not be updated: {0}".format(exc))

    return {
        "success": True,
        "asset_path": asset_path,
        "closed": True if verified is None else (not verified),
        "was_open": was_open,
        "closed_count": closed_count,
        "verified": None if verified is None else (not verified),
        "tracked": tracked,
        "warnings": warnings,
    }


def list_open_assets(_args=None):
    subsystem, error = _asset_editor_subsystem()
    if subsystem is None:
        return {"success": False, "message": error, "assets": [], "count": 0}

    assets = _edited_assets(subsystem)
    if assets is None:
        records = _tracked_asset_records()
        return {
            "success": True,
            "count": len(records),
            "assets": records,
            "tracked_only": True,
            "warnings": [
                "AssetEditorSubsystem does not expose GetEditedAssets in this editor build; entries are tracked from MCP open_asset/focus_asset/close_asset calls only, so tabs opened elsewhere are not listed."
            ],
        }

    records = [_asset_record(asset) for asset in assets]
    records.sort(key=lambda record: record["asset_path"].lower())
    return {
        "success": True,
        "count": len(records),
        "assets": records,
        "warnings": [],
    }


def focus_asset(args):
    asset_path, asset = _load_tab_asset(args)
    if asset is None or not _asset_exists(asset_path):
        return {
            "success": False,
            "reason": "not_found",
            "asset_path": asset_path,
            "focused": False,
            "message": "Asset not found: {0}".format(asset_path),
        }
    subsystem, error = _asset_editor_subsystem()
    if subsystem is None:
        return {
            "success": False,
            "asset_path": asset_path,
            "focused": False,
            "message": error,
        }

    was_open = _is_asset_open(subsystem, asset)
    method_name, errors = _open_asset_editor(subsystem, asset)
    if not method_name:
        return {
            "success": False,
            "asset_path": asset_path,
            "focused": False,
            "message": "No asset editor focus/open function is exposed in this editor build.",
            "errors": errors,
        }

    verified = _is_asset_open(subsystem, asset)
    warnings = []
    if verified is not True:
        warnings.append(
            "The editor did not confirm the asset as edited; focus could not be verified."
        )
    if errors:
        warnings.extend(errors)

    try:
        _track_open(asset_path, "focus_asset")
        tracked = True
    except Exception as exc:
        tracked = False
        warnings.append("Open state could not be tracked: {0}".format(exc))

    return {
        "success": True,
        "asset_path": asset_path,
        "focused": True if verified else None,
        "was_open": was_open,
        "opened_by_focus": was_open is False,
        "method": method_name,
        "handle": _asset_record(asset),
        "tracked": tracked,
        "warnings": warnings,
    }

# ---------------------------------------------------------------------------
# PIE expectations
# ---------------------------------------------------------------------------


def _pie_context():
    game_world = None
    pie_worlds = []

    try:
        if hasattr(unreal.EditorLevelLibrary, "get_game_world"):
            game_world = unreal.EditorLevelLibrary.get_game_world()
    except Exception:
        game_world = None

    try:
        if hasattr(unreal.EditorLevelLibrary, "get_pie_worlds"):
            try:
                pie_worlds = list(unreal.EditorLevelLibrary.get_pie_worlds(False))
            except TypeError:
                pie_worlds = list(unreal.EditorLevelLibrary.get_pie_worlds())
    except Exception:
        pie_worlds = []

    return game_world, pie_worlds


def _world_actors(game_world):
    actors = []
    if game_world is not None:
        try:
            actors = list(
                unreal.GameplayStatics.get_all_actors_of_class(game_world, unreal.Actor)
            )
        except Exception:
            actors = []

    if actors:
        return actors, "pie"

    try:
        return list(get_all_level_actors()), "editor"
    except Exception:
        return [], "none"


def _actor_label(actor):
    try:
        return str(actor.get_actor_label())
    except Exception:
        return ""


def _find_actor(actors, actor_name):
    target = str(actor_name or "").strip()
    if not target:
        return None

    target_lower = target.lower()
    for actor in actors:
        for candidate in (get_object_name(actor), _actor_label(actor)):
            if candidate and candidate.lower() == target_lower:
                return actor
    return None


def _actor_location(actor):
    try:
        location = actor.get_actor_location()
    except Exception:
        return None

    try:
        return {
            "x": float(location.x),
            "y": float(location.y),
            "z": float(location.z),
        }
    except Exception:
        return None


def _safe_getattr(target, attribute_name):
    try:
        value = getattr(target, attribute_name)
    except Exception:
        return None, False

    if callable(value):
        try:
            return value(), True
        except Exception:
            return None, False

    return value, True


def _read_property(actor, property_path):
    current = actor
    for segment in str(property_path or "").split("."):
        if not segment:
            continue
        if current is None:
            return None, "Property path ended early at '{0}'.".format(segment)

        value = None
        found = False

        try:
            if hasattr(current, "get_editor_property"):
                value = current.get_editor_property(segment)
                found = True
        except Exception:
            found = False

        if not found:
            value, found = _safe_getattr(current, segment)

        if not found:
            return None, "Property '{0}' is not readable on this object.".format(segment)

        current = value

    return current, ""


def _to_jsonable(value, depth=0):
    if depth > 4:
        return str(value)

    if value is None or isinstance(value, (bool, int, str)):
        return value

    if isinstance(value, float):
        return value

    has_axes = True
    for axis in ("x", "y", "z"):
        if not hasattr(value, axis):
            has_axes = False
            break
    if has_axes:
        try:
            return {
                "x": float(value.x),
                "y": float(value.y),
                "z": float(value.z),
            }
        except Exception:
            pass

    if isinstance(value, (list, tuple)):
        return [_to_jsonable(item, depth + 1) for item in value]

    name, found = _safe_getattr(value, "get_name")
    if found and name:
        return str(name)

    return str(value)


def _values_match(actual, expected, tolerance=1e-6):
    if isinstance(expected, bool):
        return bool(actual) == expected

    if isinstance(expected, (int, float)):
        try:
            return abs(float(actual) - float(expected)) <= tolerance
        except (TypeError, ValueError):
            return False

    if isinstance(expected, str):
        return str(actual) == expected

    if isinstance(expected, (list, tuple)):
        try:
            actual_list = list(actual)
        except TypeError:
            return False
        if len(actual_list) != len(expected):
            return False
        return all(
            _values_match(actual_list[index], expected[index], tolerance)
            for index in range(len(expected))
        )

    return str(actual) == str(expected)


def _log_condition(condition, log_path, log_start_offset):
    pattern = str(condition.get("pattern") or condition.get("text") or "")
    if not pattern:
        return {
            "passed": False,
            "observed": {"matched": False},
            "message": "log_contains requires pattern or text.",
        }

    if not log_path:
        return {
            "passed": False,
            "observed": {"matched": False, "log_path": None},
            "message": "No editor log file was found under Saved/Logs.",
        }

    text, chunk_start, log_end = _read_log_chunk(log_path, log_start_offset)
    lines = _log_lines(text, max_lines=_LOG_TAIL_LINES + 200, strip_prefix=False)

    case_sensitive = bool(condition.get("case_sensitive"))
    matcher = None
    if bool(condition.get("regex")):
        try:
            matcher = re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
        except re.error as exc:
            return {
                "passed": False,
                "observed": {"matched": False, "log_path": log_path},
                "message": "Invalid regular expression: {0}".format(exc),
            }

    matched_line = ""
    match_count = 0
    needle = pattern if case_sensitive else pattern.lower()
    for line in lines:
        if matcher is not None:
            hit = matcher.search(line) is not None
        elif case_sensitive:
            hit = needle in line
        else:
            hit = needle in line.lower()

        if not hit:
            continue

        match_count += 1
        if not matched_line:
            matched_line = _LOG_PREFIX.sub("", line).strip()[:300]

    observed = {
        "matched": match_count > 0,
        "match_count": match_count,
        "matched_line": matched_line,
        "pattern": pattern,
        "log_path": log_path,
        "log_start_offset": chunk_start,
        "log_end_offset": log_end,
    }
    return {"passed": match_count > 0, "observed": observed}


def _evaluate_condition(condition, context):
    kind = str(condition.get("kind") or "").strip().lower()
    actors = context["actors"]
    world_kind = context["world"]

    if kind == "log_contains":
        return _log_condition(condition, context["log_path"], context["log_start_offset"])

    if kind not in ("actor_exists", "actor_location", "property_equals"):
        return {
            "passed": False,
            "observed": {"kind": kind},
            "message": "Unknown condition kind: {0}".format(kind or "(missing)"),
        }

    actor_name = condition.get("actor_name") or condition.get("name")
    actor = _find_actor(actors, actor_name)
    if actor is None:
        return {
            "passed": False,
            "observed": {
                "found": False,
                "actor_name": actor_name,
                "world": world_kind,
                "actor_count": len(actors),
            },
            "message": "Actor not found: {0}".format(actor_name),
        }

    if kind == "actor_exists":
        return {
            "passed": True,
            "observed": {
                "found": True,
                "actor_name": get_object_name(actor),
                "actor_label": _actor_label(actor),
                "actor_class": get_object_class_name(actor),
                "world": world_kind,
            },
        }

    if kind == "actor_location":
        location = _actor_location(actor)
        expected = condition.get("expected")
        tolerance = condition.get("tolerance")

        observed = {
            "found": True,
            "actor_name": get_object_name(actor),
            "location": location,
            "expected": expected,
            "world": world_kind,
        }

        if expected is None:
            return {"passed": location is not None, "observed": observed}

        if location is None:
            return {
                "passed": False,
                "observed": observed,
                "message": "Actor location is unavailable.",
            }

        try:
            expected_values = [float(item) for item in list(expected)[:3]]
            tolerance_value = (
                float(tolerance) if isinstance(tolerance, (int, float)) else 1.0
            )
        except (TypeError, ValueError):
            return {
                "passed": False,
                "observed": observed,
                "message": "expected must be [x, y, z].",
            }

        while len(expected_values) < 3:
            expected_values.append(0.0)

        deltas = [
            float(location[axis]) - expected_values[index]
            for index, axis in enumerate(("x", "y", "z"))
        ]
        distance = (deltas[0] ** 2 + deltas[1] ** 2 + deltas[2] ** 2) ** 0.5
        observed["distance"] = distance
        observed["tolerance"] = tolerance_value
        return {"passed": distance <= tolerance_value, "observed": observed}

    property_path = condition.get("property")
    if not property_path:
        return {
            "passed": False,
            "observed": {"found": True, "actor_name": get_object_name(actor)},
            "message": "property_equals requires property.",
        }

    value, error = _read_property(actor, property_path)
    actual = _to_jsonable(value)
    expected = condition.get("expected")
    observed = {
        "found": True,
        "actor_name": get_object_name(actor),
        "property": property_path,
        "value": actual,
        "expected": expected,
        "world": world_kind,
    }
    if error:
        observed["error"] = error
        return {"passed": False, "observed": observed, "message": error}

    tolerance = condition.get("tolerance")
    tolerance_value = float(tolerance) if isinstance(tolerance, (int, float)) else 1e-6
    return {
        "passed": _values_match(actual, expected, tolerance_value),
        "observed": observed,
    }


def pie_probe(args):
    conditions = args.get("conditions")
    if not isinstance(conditions, list) or not conditions:
        return {"success": False, "message": "conditions must be a non-empty array"}

    warnings = []
    if len(conditions) > _MAX_CONDITIONS:
        warnings.append(
            "Only the first {0} conditions were evaluated.".format(_MAX_CONDITIONS)
        )
        conditions = conditions[:_MAX_CONDITIONS]

    game_world, pie_worlds = _pie_context()
    actors, world_kind = _world_actors(game_world)
    log_path = _find_log_file(args.get("log_path"))
    log_start_offset = args.get("log_start_offset")
    if log_start_offset is None and args.get("pin_log_first"):
        # Pin the log window to the current end of the file so the first probe
        # cannot match lines written before pie_expect was called.
        log_start_offset = _log_size(log_path) if log_path else None
    context = {
        "actors": actors,
        "world": world_kind,
        "log_path": log_path,
        "log_start_offset": log_start_offset,
    }

    results = []
    for condition in conditions:
        if not isinstance(condition, dict):
            results.append(
                {
                    "kind": "(invalid)",
                    "passed": False,
                    "observed": {},
                    "message": "Each condition must be an object.",
                }
            )
            continue

        entry = _evaluate_condition(condition, context)
        # Conditions that depend on the log share one pinned offset; the first
        # log condition pins the end of the window it searched so later probes
        # never re-report lines from before the expect started.
        entry["kind"] = str(condition.get("kind") or "").strip().lower()
        if entry["kind"] == "log_contains":
            observed = entry.get("observed") or {}
            if context["log_start_offset"] is None and observed.get("log_end_offset"):
                context["log_start_offset"] = observed["log_end_offset"]
        results.append(entry)

    if not log_path:
        warnings.append(
            "No editor log file was found under Saved/Logs; log_contains cannot pass."
        )

    if world_kind != "pie" and any(
        str(condition.get("kind") or "") != "log_contains" for condition in conditions
    ):
        warnings.append(
            "PIE is not running; actor conditions were evaluated against the editor world."
        )

    return {
        "success": True,
        "is_pie_running": bool(game_world or pie_worlds),
        "game_world_name": get_object_name(game_world) if game_world else None,
        "pie_world_count": len(pie_worlds),
        "world": world_kind,
        "actor_count": len(actors),
        "conditions": results,
        "log_path": log_path or None,
        "log_start_offset": context["log_start_offset"],
        "warnings": warnings,
    }


OPERATIONS = {
    "console_command": console_command,
    "get_console_variable": get_console_variable,
    "open_asset": open_asset,
    "close_asset": close_asset,
    "list_open_assets": list_open_assets,
    "focus_asset": focus_asset,
    "pie_probe": pie_probe,
}


def main():
    operation = decode_template_json("""${operation}""")
    args = decode_template_json("""${args}""")

    handler = OPERATIONS.get(operation)
    if not handler:
        print(
            json.dumps(
                {
                    "success": False,
                    "message": "Unknown editor runtime operation: {0}".format(operation),
                },
                indent=2,
            )
        )
        return

    try:
        result = handler(args or {})
    except Exception as exc:
        result = {"success": False, "message": str(exc)}

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
