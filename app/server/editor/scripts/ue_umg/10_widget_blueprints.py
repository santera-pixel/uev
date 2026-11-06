def _find_existing_widget_asset(asset_path, asset_name):
    try:
        asset = unreal.EditorAssetLibrary.load_asset(asset_path)
        if asset:
            return asset
    except Exception:
        pass

    try:
        asset = unreal.find_object(None, "{0}.{1}".format(asset_path, asset_name))
        if asset:
            return asset
    except Exception:
        pass

    return None


def create_umg_widget_blueprint(args):
    widget_name = args.get("widget_name") or args.get("asset_path") or args.get("name")
    parent_class_name = args.get("parent_class") or "UserWidget"
    content_path = args.get("path")
    asset_key = str(args.get("asset_path") or "").strip().rstrip("/")
    if not content_path and "/" in asset_key:
        folder = asset_key.rsplit("/", 1)[0]
        leaf = asset_key.rsplit("/", 1)[-1].split(".")[0]
        name_leaf = str(widget_name or "").rstrip("/").rsplit("/", 1)[-1].split(".")[0]
        content_path = folder if leaf and leaf == name_leaf else asset_key
    content_path = content_path or "/Game/UI"

    pie_error = require_editor_not_in_play("create_widget_blueprint")
    if pie_error:
        return pie_error

    asset_name, package_path = split_asset_name_and_path(widget_name, content_path)
    asset_path = "{0}/{1}".format(package_path, asset_name)
    if unreal.EditorAssetLibrary.does_asset_exist(asset_path):
        return {
            "success": False,
            "message": "Widget blueprint asset already exists: {0}".format(asset_path),
            "reason": "asset_already_exists",
            "asset_path": asset_path,
            "persisted": True,
        }

    existing_asset = _find_existing_widget_asset(asset_path, asset_name)
    if existing_asset is not None:
        return {
            "success": False,
            "message": "Widget blueprint asset already exists in memory but is not saved: {0}. Stop Play-In-Editor and retry.".format(
                asset_path
            ),
            "reason": "asset_already_exists",
            "asset_path": asset_path,
            "persisted": False,
        }

    parent_class = resolve_class_reference(parent_class_name, ["UMG"])
    if not parent_class:
        return {
            "success": False,
            "message": "Widget parent class not found: {0}".format(parent_class_name),
        }

    parent_uclass = get_UClass(parent_class)
    if not parent_uclass:
        return {
            "success": False,
            "message": "Could not resolve UClass for widget parent class: {0}".format(
                parent_class_name
            ),
        }

    # Editor Utility Widgets need EditorUtilityWidgetBlueprintFactory. Creating
    # them with WidgetBlueprintFactory yields a plain WidgetBlueprint whose
    # parent happens to be EditorUtilityWidget; that asset is rejected by
    # EditorUtilitySubsystem.spawn_and_register_tab().
    editor_utility_base = getattr(unreal, "EditorUtilityWidget", None)
    is_editor_utility = bool(
        editor_utility_base and class_is_child_of(parent_class, editor_utility_base)
    )
    asset_class = unreal.WidgetBlueprint
    if is_editor_utility and hasattr(unreal, "EditorUtilityWidgetBlueprintFactory"):
        factory = unreal.EditorUtilityWidgetBlueprintFactory()
        if hasattr(unreal, "EditorUtilityWidgetBlueprint"):
            asset_class = unreal.EditorUtilityWidgetBlueprint
    else:
        factory = unreal.WidgetBlueprintFactory()

    try:
        factory.set_editor_property("parent_class", parent_uclass)
    except Exception as exc:
        return {
            "success": False,
            "message": "Failed to assign widget blueprint parent class '{0}': {1}".format(
                parent_class_name, exc
            ),
        }
    widget_blueprint = create_asset_with_factory(
        asset_name,
        package_path,
        asset_class,
        factory,
    )
    if not widget_blueprint:
        return {
            "success": False,
            "message": "Failed to create widget blueprint asset '{0}'".format(asset_name),
            "asset_path": asset_path,
        }

    saved = save_widget_blueprint(widget_blueprint)
    persisted = False
    try:
        persisted = bool(unreal.EditorAssetLibrary.does_asset_exist(asset_path))
    except Exception:
        persisted = False

    if not persisted:
        return {
            "success": False,
            "message": "Widget blueprint '{0}' was created in memory but could not be saved to disk. Stop Play-In-Editor and retry.".format(
                asset_path
            ),
            "reason": "asset_not_persisted",
            "asset_path": asset_path,
            "persisted": False,
            "saved": bool(saved),
        }

    return {
        "success": True,
        "widget_name": asset_name,
        "asset_path": asset_path,
        "parent_class": get_object_name(parent_uclass),
        "persisted": True,
    }


def launch_editor_utility(args):
    """Open an Editor Utility Widget as a docked tab in the editor."""
    widget_name = args.get("widget_name") or args.get("asset_path")
    if not widget_name:
        return {"success": False, "message": "widget_name or asset_path is required."}

    pie_error = require_editor_not_in_play("launch_editor_utility")
    if pie_error:
        return pie_error

    try:
        asset = None
        try:
            asset = load_blueprint_asset(widget_name, allow_widget=True)
        except Exception:
            asset = None
        if not asset:
            asset = unreal.EditorAssetLibrary.load_asset(widget_name)
        if not asset:
            asset = unreal.find_object(None, "{0}.{1}".format(
                widget_name, str(widget_name).rsplit("/", 1)[-1]))
        if not asset:
            return {"success": False, "message": "Editor utility widget asset not found: {0}".format(widget_name)}

        expected = getattr(unreal, "EditorUtilityWidgetBlueprint", None)
        if expected and not isinstance(asset, expected):
            return {
                "success": False,
                "message": "{0} is a {1}, not an EditorUtilityWidgetBlueprint. Recreate it with parent_class EditorUtilityWidget.".format(
                    widget_name, get_object_class_name(asset)
                ),
            }

        subsystem = unreal.get_editor_subsystem(unreal.EditorUtilitySubsystem)
        if not subsystem:
            return {"success": False, "message": "EditorUtilitySubsystem is unavailable."}
        widget = subsystem.spawn_and_register_tab(asset)
        if not widget:
            return {"success": False, "message": "EditorUtilitySubsystem could not open the widget."}
        return {
            "success": True,
            "widget_blueprint": get_asset_package_name(asset),
            "widget": get_object_name(widget),
        }
    except Exception as exc:
        return {"success": False, "message": str(exc)}
