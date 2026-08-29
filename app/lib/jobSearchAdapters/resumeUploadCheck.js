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
const GENERIC_UPLOAD_ERROR_TEXT = /(failed to upload|upload failed|error uploading|couldn't upload|could not upload)/i;
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
