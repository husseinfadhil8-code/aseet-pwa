function pageCursorFilter(cursor) {
  if (!cursor || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)
    || !/^[0-9T:.+Z-]+$/.test(cursor.created_at) || !Number.isFinite(Date.parse(cursor.created_at))) throw new Error('تعذّر قراءة مؤشر الصفحة. حدّث البيانات.');
  return `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`;
}
