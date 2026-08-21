-- Per-field confidence for the review UI.
--
-- Confidence has only ever been stored once per whole document
-- (ocr_extraction_run.extraction_confidence, lib/review/types.ts's
-- confidenceTint) -- a reviewer could see "this document is amber" but never
-- which specific field to actually double-check. Reading the real failures
-- on the two hand-labeled gold bills (test1.pdf/test2.pdf) showed the errors
-- are concentrated on individual illegible digits/words (a handwritten ₹400
-- read as ₹4100, an invoice number "756" read as "356"), not whole-document
-- unreliability -- so per-field is the granularity that actually helps.
--
-- No _verified twin, unlike every other _ocr column on this table: this is
-- not a fact a reviewer corrects, it's the model's own confidence signal
-- about facts already sitting in the other _ocr columns -- same footing as
-- classification_confidence on document_page, which also has no twin.
--
-- jsonb, not a new table: one bill has at most a handful of uncertain
-- fields (usually zero), and the only access pattern is "load this bill's
-- whole list for the review screen" -- never queried or filtered on its own,
-- so there is nothing a relational shape would buy here.
--   [{"field": "total_amount", "line_order": null, "page_number": 1,
--     "bbox_x0": 0.62, "bbox_y0": 0.71, "bbox_x1": 0.84, "bbox_y1": 0.76}, ...]
-- field/line_order/page_number/bbox_* mirror extractionUncertainFieldSchema
-- (lib/extraction-schema.ts) field-for-field -- see that file for the full
-- shape and why bbox is a 0-1 fraction of the page, not pixels.
alter table public.document_extraction
  add column uncertain_fields_ocr jsonb not null default '[]'::jsonb;

comment on column public.document_extraction.uncertain_fields_ocr is
  'Fields the model transcribed but doubts, for the review UI''s per-field highlight and on-page box (components/review/extraction-form.tsx, pdf-viewer.tsx). Written once per extraction run alongside the other _ocr columns; never verified/corrected directly.';
