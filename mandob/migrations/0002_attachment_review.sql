-- No existing messages/items/photos are deleted. Review gates future storage and indexing.
ALTER TABLE media ADD COLUMN approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN(0,1));
UPDATE media SET state='review' WHERE state='pending';
CREATE INDEX media_review_page ON media(page_id,state,approved);
-- Existing image-derived vectors have no reliable review provenance. Retain but exclude them.
UPDATE embeddings SET model=model||':review_required' WHERE item_id IN (SELECT item_id FROM media WHERE approved=0);
