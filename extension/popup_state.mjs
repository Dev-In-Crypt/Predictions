export const UiStates = {
  IDLE: "idle",
  CHECKING: "checking",
  ANALYZING: "analyzing",
  DONE: "done",
  ERROR: "error",
};

export function transition(state, event) {
  switch (event) {
    case "CHECK_START":
      return UiStates.CHECKING;
    case "CHECK_OK":
      return state === UiStates.CHECKING ? UiStates.IDLE : state;
    case "CHECK_FAIL":
      return UiStates.ERROR;
    case "ANALYZE_START":
      return UiStates.ANALYZING;
    case "ANALYZE_DONE":
      return UiStates.DONE;
    case "ANALYZE_ERROR":
      return UiStates.ERROR;
    default:
      return state;
  }
}

export function deriveUi(state, { serviceOk, onPolymarket, errorLabel } = {}) {
  let status = "Idle";
  let isError = false;

  switch (state) {
    case UiStates.CHECKING:
      status = "Checking service";
      break;
    case UiStates.ANALYZING:
      status = "Analyzing";
      break;
    case UiStates.DONE:
      status = "Done";
      break;
    case UiStates.ERROR:
      if (serviceOk === false) {
        status = "Service offline";
      } else {
        status = errorLabel || "Error";
      }
      isError = status !== "Cancelled";
      break;
    case UiStates.IDLE:
    default:
      status = "Idle";
      break;
  }

  if (serviceOk && !onPolymarket && state !== UiStates.ANALYZING && state !== UiStates.CHECKING) {
    status = "Open a Polymarket event page";
    isError = true;
  }

  return { status, isError };
}

export function computeControls({ state, serviceOk, onPolymarket, errorLabel }) {
  const analyzeDisabled =
    state === UiStates.CHECKING ||
    state === UiStates.ANALYZING ||
    !serviceOk ||
    !onPolymarket;

  const showRetry =
    state === UiStates.ERROR && serviceOk && onPolymarket && errorLabel !== "Cancelled";
  const showCancel = state === UiStates.ANALYZING;

  return { analyzeDisabled, showRetry, showCancel };
}
