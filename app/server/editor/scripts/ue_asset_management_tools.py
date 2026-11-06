import json


def _normalize_content_path(path_value, default_path="/Game"):
    normalized = str(path_value or "").strip()
    if not normalized:
        normalized = default_path

    if not normalized.startswith("/"):
        normalized = "/Game/{0}".format(normalized.strip("/"))

    return normalized.rstrip("/") or "/Game"


def _asset_summary(asset):
    if not asset:
        return None

    return {
        "name": get_object_name(asset),
        "class": get_object_class_name(asset),
        "asset_path": get_asset_package_name(asset) or get_asset_object_path(asset),
        "object_path": get_asset_object_path(asset),
    }


def _resolve_destination_asset_path(args, source_asset_path, require_new_path=False):
    explicit_destination = str(
        args.get("destination_asset_path")
        or args.get("target_asset_path")
        or args.get("asset_path")
        or ""
    ).strip()
    if explicit_destination:
        return normalize_asset_reference_path(explicit_destination)

    source_package = normalize_asset_reference_path(source_asset_path)
    source_name = source_package.rsplit("/", 1)[-1]
    source_directory = source_package.rsplit("/", 1)[0] if "/" in source_package else "/Game"

    destination_path = args.get("destination_path") or args.get("path")
    new_name = str(args.get("new_name") or args.get("name") or "").strip()

    if require_new_path and not destination_path and not new_name:
        raise ValueError(
            "destination_asset_path, destination_path, or new_name is required."
        )

    destination_directory = _normalize_content_path(destination_path, source_directory)
    destination_name = new_name or source_name
    return "{0}/{1}".format(destination_directory, destination_name)


def _collect_asset_paths(args):
    candidate_paths = args.get("asset_paths")
    if isinstance(candidate_paths, list):
        normalized_paths = [
            normalize_asset_reference_path(asset_path)
            for asset_path in candidate_paths
            if str(asset_path or "").strip()
        ]
        return [asset_path for asset_path in normalized_paths if asset_path]

    single_path = args.get("asset_path") or args.get("path") or args.get("name")
    normalized_single = normalize_asset_reference_path(single_path)
    return [normalized_single] if normalized_single else []


def _list_directory_entries(directory_path, recursive=False):
    normalized_directory = _normalize_content_path(directory_path)
    is_recursive = bool(recursive)

    try:
        entries = unreal.EditorAssetLibrary.list_assets(
            normalized_directory, recursive=is_recursive, include_folder=True
        )
    except TypeError:
        try:
            entries = unreal.EditorAssetLibrary.list_assets(
                normalized_directory, is_recursive, True
            )
        except TypeError:
            entries = unreal.EditorAssetLibrary.list_assets(
                normalized_directory, is_recursive
            )

    asset_paths = []
    folder_paths = []
    for entry in entries or []:
        normalized_entry = normalize_asset_reference_path(entry)
        if not normalized_entry:
            continue

        try:
            if unreal.EditorAssetLibrary.does_directory_exist(normalized_entry):
                folder_paths.append(normalized_entry)
                continue
        except Exception:
            pass

        asset_paths.append(normalized_entry)

    return normalized_directory, sorted(set(folder_paths)), sorted(set(asset_paths))


def asset_exists(args):
    asset_paths = _collect_asset_paths(args)
    if not asset_paths:
        return {"success": False, "message": "asset_path, path, name, or asset_paths is required."}

    results = []
    for asset_path in asset_paths:
        exists = False
        try:
            exists = bool(unreal.EditorAssetLibrary.does_asset_exist(asset_path))
        except Exception:
            exists = False
        results.append({"asset_path": asset_path, "exists": exists})

    if len(results) == 1:
        result = results[0]
        return {
            "success": True,
            "asset_path": result["asset_path"],
            "exists": result["exists"],
        }

    return {
        "success": True,
        "count": len(results),
        "all_exist": all(result["exists"] for result in results),
        "results": results,
    }


def duplicate_asset(args):
    source_asset_path = normalize_asset_reference_path(
        args.get("source_asset_path")
        or args.get("source_path")
        or args.get("asset_path")
        or args.get("path")
    )
    if not source_asset_path:
        return {
            "success": False,
            "message": "source_asset_path, source_path, asset_path, or path is required.",
        }

    if not unreal.EditorAssetLibrary.does_asset_exist(source_asset_path):
        return {"success": False, "message": "Source asset does not exist: {0}".format(source_asset_path)}

    destination_asset_path = _resolve_destination_asset_path(
        args, source_asset_path, require_new_path=True
    )
    is_world_asset = (
        source_asset_path.lower().endswith(".umap")
        or "/maps/" in source_asset_path.lower()
    )
    if not is_world_asset:
        try:
            asset_data = unreal.EditorAssetLibrary.find_asset_data(source_asset_path)
            class_name = (
                str(asset_data.asset_class_path.asset_name).lower()
                if asset_data
                else ""
            )
            is_world_asset = class_name in ("world", "uworld")
        except Exception:
            pass

    if is_world_asset:
        created = unreal.EditorLevelLibrary.new_level_from_template(
            destination_asset_path, source_asset_path
        )
        if not created:
            return {
                "success": False,
                "message": "Failed to duplicate map.",
                "source_asset_path": source_asset_path,
                "destination_asset_path": destination_asset_path,
            }
        return {
            "success": True,
            "operation": "duplicate_map",
            "source_asset_path": source_asset_path,
            "destination_asset_path": destination_asset_path,
            "note": "The new level was created and opened.",
        }

    duplicated_asset = unreal.EditorAssetLibrary.duplicate_asset(
        source_asset_path, destination_asset_path
    )

    if not duplicated_asset:
        return {
            "success": False,
            "message": "Failed to duplicate asset.",
            "source_asset_path": source_asset_path,
            "destination_asset_path": destination_asset_path,
        }

    return {
        "success": True,
        "operation": "duplicate",
        "source_asset_path": source_asset_path,
        "destination_asset_path": destination_asset_path,
        "asset": _asset_summary(duplicated_asset),
    }


def rename_asset(args):
    source_asset_path = normalize_asset_reference_path(
        args.get("source_asset_path")
        or args.get("source_path")
        or args.get("asset_path")
        or args.get("path")
    )
    if not source_asset_path:
        return {
            "success": False,
            "message": "source_asset_path, source_path, asset_path, or path is required.",
        }

    destination_asset_path = _resolve_destination_asset_path(
        args, source_asset_path, require_new_path=True
    )
    renamed = bool(
        unreal.EditorAssetLibrary.rename_asset(source_asset_path, destination_asset_path)
    )

    return {
        "success": renamed,
        "operation": "rename",
        "source_asset_path": source_asset_path,
        "destination_asset_path": destination_asset_path,
        "exists_after": bool(
            unreal.EditorAssetLibrary.does_asset_exist(destination_asset_path)
        ),
    }


def move_asset(args):
    pie_refusal = crash_guard_refuse_pie("move asset")
    if pie_refusal:
        return pie_refusal

    source_asset_path = normalize_asset_reference_path(
        args.get("source_asset_path")
        or args.get("source_path")
        or args.get("asset_path")
        or args.get("path")
    )
    if not source_asset_path:
        return {
            "success": False,
            "message": "source_asset_path, source_path, asset_path, or path is required.",
        }

    destination_path = args.get("destination_path")
    if not destination_path and not args.get("destination_asset_path"):
        return {
            "success": False,
            "message": "destination_path or destination_asset_path is required for move.",
        }

    destination_asset_path = _resolve_destination_asset_path(
        args, source_asset_path, require_new_path=True
    )
    moved = bool(
        unreal.EditorAssetLibrary.rename_asset(source_asset_path, destination_asset_path)
    )

    return {
        "success": moved,
        "operation": "move",
        "source_asset_path": source_asset_path,
        "destination_asset_path": destination_asset_path,
        "exists_after": bool(
            unreal.EditorAssetLibrary.does_asset_exist(destination_asset_path)
        ),
    }


def _loaded_asset_paths(asset_paths):
    loaded = []
    for asset_path in asset_paths:
        try:
            asset_data = unreal.EditorAssetLibrary.find_asset_data(asset_path)
            if asset_data and asset_data.is_asset_loaded():
                loaded.append(asset_path)
        except Exception:
            continue
    return loaded


def _prepare_assets_for_deletion(asset_paths):
    """Save dirty assets, close editor tabs, and close asset editors.

    UEditorAssetLibrary.delete_asset/delete_directory calls ForceDeleteObjects.
    Two UE4.27 crash paths were observed when deleting assets that are open:
    asset editors and spawned Editor Utility Widget dock tabs (Blutility's
    HandleAssetRemoved -> UpdateRespawnListIfNeeded). Close both before the
    delete and refuse if either cannot be closed.
    """
    loaded = _loaded_asset_paths(asset_paths)
    if not loaded:
        return {
            "available": True,
            "loaded_assets": [],
            "closed_editors": 0,
            "closed_utility_tabs": 0,
            "save_failures": [],
        }

    save_failures = []
    for asset_path in loaded:
        try:
            if not unreal.EditorAssetLibrary.save_asset(asset_path, True):
                save_failures.append(asset_path)
        except Exception as exc:
            save_failures.append("{0} ({1})".format(asset_path, exc))
    if save_failures:
        return {
            "available": False,
            "loaded_assets": loaded,
            "closed_editors": 0,
            "closed_utility_tabs": 0,
            "save_failures": save_failures,
            "message": "Refusing to delete: loaded assets could not be saved before closing their editors.",
        }

    try:
        subsystem_class = getattr(unreal, "AssetEditorSubsystem", None)
        if subsystem_class is None:
            return {
                "available": False,
                "loaded_assets": loaded,
                "closed_editors": 0,
                "closed_utility_tabs": 0,
                "save_failures": [],
                "message": "Refusing to delete: AssetEditorSubsystem is not exposed to Python, so open asset editors cannot be closed safely.",
            }
        subsystem = unreal.get_editor_subsystem(subsystem_class)
        if subsystem is None:
            return {
                "available": False,
                "loaded_assets": loaded,
                "closed_editors": 0,
                "closed_utility_tabs": 0,
                "save_failures": [],
                "message": "Refusing to delete: AssetEditorSubsystem is unavailable.",
            }

        utility_class = getattr(unreal, "EditorUtilitySubsystem", None)
        utility_subsystem = (
            unreal.get_editor_subsystem(utility_class) if utility_class else None
        )
        widget_blueprint_class = getattr(unreal, "EditorUtilityWidgetBlueprint", None)

        closed_editors = 0
        closed_tabs = 0
        tab_failures = []
        for asset_path in loaded:
            asset = unreal.EditorAssetLibrary.load_asset(asset_path)
            if not asset:
                continue
            if widget_blueprint_class and isinstance(asset, widget_blueprint_class):
                if utility_subsystem is None:
                    tab_failures.append(
                        "{0} (EditorUtilitySubsystem unavailable)".format(asset_path)
                    )
                else:
                    tab_id = unreal.Name(
                        "{0}_ActiveTab".format(asset.get_path_name())
                    )
                    try:
                        if utility_subsystem.does_tab_exist(tab_id):
                            if utility_subsystem.close_tab_by_id(tab_id):
                                closed_tabs += 1
                            else:
                                tab_failures.append(
                                    "{0} (CloseTabByID returned false)".format(
                                        asset_path
                                    )
                                )
                    except Exception as exc:
                        tab_failures.append("{0} ({1})".format(asset_path, exc))
            closed_editors += int(subsystem.close_all_editors_for_asset(asset))

        if tab_failures:
            return {
                "available": False,
                "loaded_assets": loaded,
                "closed_editors": closed_editors,
                "closed_utility_tabs": closed_tabs,
                "save_failures": [],
                "message": "Refusing to delete: could not close Editor Utility Widget tabs: {0}".format(
                    ", ".join(tab_failures)
                ),
            }

        return {
            "available": True,
            "loaded_assets": loaded,
            "closed_editors": closed_editors,
            "closed_utility_tabs": closed_tabs,
            "save_failures": [],
        }
    except Exception as exc:
        return {
            "available": False,
            "loaded_assets": loaded,
            "closed_editors": 0,
            "closed_utility_tabs": 0,
            "save_failures": [],
            "message": "Refusing to delete: failed to close asset editors: {0}".format(exc),
        }


def delete_assets(args):
    # Crash guards: an in-flight Asset Registry scan or a live PIE session makes
    # ForceDeleteObjects run against objects the engine still owns.
    busy_refusal = crash_guard_refuse_asset_registry_busy("delete assets")
    if busy_refusal:
        return busy_refusal
    pie_refusal = crash_guard_refuse_pie("delete assets")
    if pie_refusal:
        return pie_refusal

    asset_paths = _collect_asset_paths(args)
    if not asset_paths:
        return {"success": False, "message": "asset_path, path, name, or asset_paths is required."}

    guard = _prepare_assets_for_deletion(asset_paths)
    if not guard["available"]:
        return {
            "success": False,
            "operation": "delete",
            "message": guard["message"],
            "loaded_assets": guard["loaded_assets"],
            "save_failures": guard["save_failures"],
            "deleted": [],
            "failed": [{"asset_path": p, "message": guard["message"]} for p in asset_paths],
        }

    deleted = []
    failed = []
    for asset_path in asset_paths:
        try:
            result = bool(unreal.EditorAssetLibrary.delete_asset(asset_path))
        except Exception as exc:
            failed.append({"asset_path": asset_path, "message": str(exc)})
            continue

        if result:
            deleted.append(asset_path)
        else:
            failed.append({"asset_path": asset_path, "message": "delete_asset returned False"})

    return {
        "success": len(failed) == 0,
        "operation": "delete",
        "deleted": deleted,
        "failed": failed,
        "processed_count": len(asset_paths),
        "deleted_count": len(deleted),
        "closed_editors": guard["closed_editors"],
        "closed_utility_tabs": guard["closed_utility_tabs"],
        "loaded_assets": guard["loaded_assets"],
    }


def save_assets(args):
    asset_paths = _collect_asset_paths(args)
    if not asset_paths:
        return {"success": False, "message": "asset_path, path, name, or asset_paths is required."}

    only_if_is_dirty = bool(args.get("only_if_is_dirty", True))
    saved = []
    failed = []
    for asset_path in asset_paths:
        try:
            result = bool(
                unreal.EditorAssetLibrary.save_asset(asset_path, only_if_is_dirty)
            )
        except Exception as exc:
            failed.append({"asset_path": asset_path, "message": str(exc)})
            continue

        if result:
            saved.append(asset_path)
        else:
            failed.append({"asset_path": asset_path, "message": "save_asset returned False"})

    return {
        "success": len(failed) == 0,
        "operation": "save",
        "only_if_is_dirty": only_if_is_dirty,
        "saved": saved,
        "failed": failed,
        "processed_count": len(asset_paths),
        "saved_count": len(saved),
    }


def create_folder(args):
    directory_path = _normalize_content_path(
        args.get("directory_path") or args.get("folder_path") or args.get("path")
    )
    created = bool(unreal.EditorAssetLibrary.make_directory(directory_path))
    return {
        "success": created,
        "operation": "create_folder",
        "directory_path": directory_path,
        "exists_after": bool(
            unreal.EditorAssetLibrary.does_directory_exist(directory_path)
        ),
    }


def list_folder(args):
    directory_path = (
        args.get("directory_path") or args.get("folder_path") or args.get("path") or "/Game"
    )
    recursive = bool(args.get("recursive", False))
    normalized_directory, folder_paths, asset_paths = _list_directory_entries(
        directory_path, recursive
    )

    return {
        "success": True,
        "operation": "list_folder",
        "directory_path": normalized_directory,
        "recursive": recursive,
        "folders": folder_paths,
        "assets": asset_paths,
        "folder_count": len(folder_paths),
        "asset_count": len(asset_paths),
    }


def delete_folder(args):
    # Crash guards: same teardown hazards as delete_assets, one level up.
    busy_refusal = crash_guard_refuse_asset_registry_busy("delete folder")
    if busy_refusal:
        return busy_refusal
    pie_refusal = crash_guard_refuse_pie("delete folder")
    if pie_refusal:
        return pie_refusal

    directory_path = _normalize_content_path(
        args.get("directory_path") or args.get("folder_path") or args.get("path")
    )
    existed_before = bool(unreal.EditorAssetLibrary.does_directory_exist(directory_path))
    asset_paths = []
    if existed_before:
        asset_paths = list(
            unreal.EditorAssetLibrary.list_assets(
                directory_path, recursive=True, include_folder=False
            )
        )

    guard = _prepare_assets_for_deletion(asset_paths)
    if not guard["available"]:
        return {
            "success": False,
            "operation": "delete_folder",
            "directory_path": directory_path,
            "existed_before": existed_before,
            "exists_after": existed_before,
            "message": guard["message"],
            "loaded_assets": guard["loaded_assets"],
            "save_failures": guard["save_failures"],
        }

    deleted = bool(unreal.EditorAssetLibrary.delete_directory(directory_path))
    return {
        "success": deleted,
        "operation": "delete_folder",
        "directory_path": directory_path,
        "existed_before": existed_before,
        "exists_after": bool(
            unreal.EditorAssetLibrary.does_directory_exist(directory_path)
        ),
        "asset_count": len(asset_paths),
        "closed_editors": guard["closed_editors"],
        "closed_utility_tabs": guard["closed_utility_tabs"],
        "loaded_assets": guard["loaded_assets"],
    }


OPERATIONS = {
    "exists": asset_exists,
    "duplicate": duplicate_asset,
    "rename": rename_asset,
    "move": move_asset,
    "delete": delete_assets,
    "save": save_assets,
    "create_folder": create_folder,
    "list_folder": list_folder,
    "delete_folder": delete_folder,
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
                    "message": "Unknown asset management operation: {0}".format(
                        operation
                    ),
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
