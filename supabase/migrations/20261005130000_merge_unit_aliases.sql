-- Merge unit spelling variants so per-unit analysis (v_quantity_by_unit etc.)
-- groups them together: sqf -> sqft, lts/ltrs/lt/litre(s)/liter(s) -> ltr.
-- App-side normalizeUnit() (lib/normalize.ts) now maps these on new saves.

update public.document_extraction_line_item
   set unit_normalized = 'sqft'
 where lower(regexp_replace(unit_normalized, '[.\s]', '', 'g')) in ('sqf', 'sqfeet');

update public.document_extraction_line_item
   set unit_normalized = 'ltr'
 where lower(regexp_replace(unit_normalized, '[.\s]', '', 'g')) in ('lts', 'ltrs', 'lt', 'litre', 'litres', 'liter', 'liters');

update public.rate_reference
   set unit_normalized = 'sqft'
 where lower(regexp_replace(unit_normalized, '[.\s]', '', 'g')) in ('sqf', 'sqfeet');

update public.rate_reference
   set unit_normalized = 'ltr'
 where lower(regexp_replace(unit_normalized, '[.\s]', '', 'g')) in ('lts', 'ltrs', 'lt', 'litre', 'litres', 'liter', 'liters');

update public.item_catalog
   set unit_normalized = 'sqft'
 where lower(regexp_replace(unit_normalized, '[.\s]', '', 'g')) in ('sqf', 'sqfeet');

update public.item_catalog
   set unit_normalized = 'ltr'
 where lower(regexp_replace(unit_normalized, '[.\s]', '', 'g')) in ('lts', 'ltrs', 'lt', 'litre', 'litres', 'liter', 'liters');
