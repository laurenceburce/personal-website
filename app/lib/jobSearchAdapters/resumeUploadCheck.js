import { resumeFilePayload } from "./resumeFilePayload.js";

// Shared by the adapters that don't have a platform-specific positive-
// confirmation signal for a resume upload the way Ashby's "Replace" button
// does (see ashby.js's own, more thorough uploadResumeAndVerify) — this is a
// lighter safety net: give the platform's own async upload processing a
// moment to run, then check for visible error text before believing
// setInputFiles() succeeded.
//
// setInputFiles() only attaches the File object to the DOM input — it says
// nothing about whether the platform's own JS then actually uploaded it
// server-side, and that step can fail invisibly to Playwright if nothing
// checks for it. Confirmed live on Ashby: a real submission attempt showed
// an on-page "... failed to upload" toast that the adapter had no idea about
// and proceeded past anyway, which then surfaced later as a confusing,
// seemingly-unrelated timeout clicking the submit button. Greenhouse/Lever/
// Workable share the exact same "setInputFiles then assume success" pattern
// Ashby had, so the same class of race is possible there too even without
// (yet) having a live-caught failure to point to.
//
// The second alternation is its own confirmed-live catch: a real GitLab
// (Greenhouse) submission crashed with "Cannot read properties of undefined
// (reading 'uploadFile')" rendered right in the field's own error text —
// Greenhouse's own upload handler racing itself, nothing to do with the file
// — which the first alternation's polite "failed to upload"-style wording
// never matches, so the adapter believed the upload succeeded and only found
// out at the very end, from the ATS's OWN "Resume/CV is required" submit-
// time validation, by which point every other field had already been filled
// for nothing. `cannot read propert(y|ies) of` is V8's own TypeError
// wording — specific enough that real job-posting copy is never going to
// contain it.
const GENERIC_UPLOAD_ERROR_TEXT = /(failed to upload|upload failed|error uploading|couldn't upload|could not upload|cannot read propert(y|ies) of)/i;
const UPLOAD_SETTLE_WAIT_MS = 2000;

// `page` is used for the wait (a real Page always has waitForTimeout; a
// FrameLocator, which Greenhouse's iframe-embedded case scopes into, does
// not) — `scope` is read for the actual text, defaulting to `page` itself
// for the common non-iframe case, since a form's own upload-error message is
// most likely rendered within that same form's DOM tree.
export async function resumeUploadLikelyFailed(page, scope = page) {
  await page.waitForTimeout(UPLOAD_SETTLE_WAIT_MS);
  const bodyText = await scope.locator("body").innerText().catch(() => "");
  return GENERIC_UPLOAD_ERROR_TEXT.test(bodyText);
}

// setInputFiles() + resumeUploadLikelyFailed(), with one retry on the SAME
// input before giving up. The crash this exists for (see the comment above)
// only reproduced once in roughly a dozen live attempts against the same
// posting, and left the input and its "Attach" button still present and
// interactive afterward (confirmed live via a DOM dump right after the
// crash) — consistent with a one-off race in the platform's own JS rather
// than anything wrong with the file or a permanently broken widget, so a
// second attempt on the same input is a reasonable recovery, not a blind
// retry. Not itself reproduced enough times to confirm the retry recovers it
// — if this keeps landing in manual review with the same crash text, that's
// the signal this needs a different fix (a longer pre-upload settle wait,
// most likely) rather than another retry.
export async function uploadResumeWithRetry(page, scope, fileInput, resumeBuffer, resumeFileName) {
  const payload = resumeFilePayload(resumeBuffer, resumeFileName);
  await fileInput.setInputFiles(payload);
  if (!(await resumeUploadLikelyFailed(page, scope))) return true;

  await fileInput.setInputFiles(payload);
  return !(await resumeUploadLikelyFailed(page, scope));
}
