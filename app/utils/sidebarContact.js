export const sidebarContactInitial = {
  name: "",
  email: "",
  message: "",
  company: ""
};

export function validateSidebarContact(values) {
  const errors = {};
  const name = String(values.name || "").trim();
  const email = String(values.email || "").trim();
  const message = String(values.message || "").trim();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!name) {
    errors.name = "Enter your name.";
  }

  if (!email || !emailPattern.test(email)) {
    errors.email = "Enter a valid email.";
  }

  if (!message) {
    errors.message = "Add a message.";
  }

  return errors;
}
