-- Module renames (obs-controller → obs, srtla → relay): dashboard widget
-- configs that store module-qualified action ids (the Buttons widget's
-- `"<module>.<action>"` keys) follow the new ids.
UPDATE dashboards SET widgets = replace(widgets, '"obs-controller.', '"obs.')
WHERE widgets LIKE '%"obs-controller.%';
UPDATE dashboards SET widgets = replace(widgets, '"srtla.', '"relay.')
WHERE widgets LIKE '%"srtla.%';
