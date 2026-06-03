export const sidebarContactInitial = {
  name: "",
  email: "",
  message: "",
  company: ""
};

export function validateSidebarContact(values) {
  const errors = {};
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!values.name.trim() || values.name.trim().length < 2) {
    errors.name = "Enter your name.";
  }

  if (!values.email.trim() || !emailPattern.test(values.email.trim())) {
    errors.email = "Enter a valid email.";
  }

  if (!values.message.trim() || values.message.trim().length < 20) {
    errors.message = "Add at least 20 characters.";
  }

  return errors;
}
