-- update-0083 (v0.84.3, bugs thread, CHRIS Nov 27): photo uploads failed with
-- "permission denied for function is_management" (Alyssa's WFH time-in).
-- The storage rules added in update-0082 (documents) call private.is_management directly as the
-- signed-in person, who wasn't allowed to run it, so every upload and photo read broke.
-- It only answers "is this person an owner or the GM?", so signed-in staff may run it. Safe to run again.
GRANT EXECUTE ON FUNCTION private.is_management(uuid) TO authenticated;
