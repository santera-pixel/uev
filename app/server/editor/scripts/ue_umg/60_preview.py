"""Native UMG preview and binding-inspection operations (1.7 designer lane).

designer_screenshot renders the designer preview through FWidgetRenderer into a render
target and writes a PNG under the project directory; inspect_selection reads the live
designer selection; list_bound_events / unbind_event read and edit the authoritative
UWidgetBlueprint::Bindings array; list_delegates enumerates the reflected multicast
delegates of the widget class (Python cannot enumerate UPROPERTY delegates).
"""


def designer_screenshot_action(args):
    return uev_widget_operation('screenshot', args)


def inspect_selection_action(args):
    return uev_widget_operation('inspect_selection', args)


def list_bound_events_action(args):
    return uev_widget_operation('list_bound_events', args)


def list_delegates_action(args):
    return uev_widget_operation('list_delegates', args)


def unbind_event_action(args):
    return uev_widget_operation('unbind_event', args)
