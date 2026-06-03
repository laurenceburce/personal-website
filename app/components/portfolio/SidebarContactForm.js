export default function SidebarContactForm({
  form,
  errors,
  status,
  isSubmitting,
  onChange,
  onSubmit
}) {
  return (
    <section id="sidebar-contact" className="sidebar-contact">
      <p className="sidebar-contact-title">Contact</p>
      <form className="sidebar-contact-form" onSubmit={onSubmit} noValidate>
        <input
          type="text"
          name="company"
          value={form.company}
          onChange={onChange}
          className="contact-honeypot"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />
        <label>
          <span>Name</span>
          <input
            type="text"
            name="name"
            value={form.name}
            onChange={onChange}
            aria-invalid={Boolean(errors.name)}
          />
        </label>
        <label>
          <span>Email</span>
          <input
            type="email"
            name="email"
            value={form.email}
            onChange={onChange}
            aria-invalid={Boolean(errors.email)}
          />
        </label>
        <label>
          <span>Message</span>
          <textarea
            name="message"
            rows={3}
            style={{ resize: "none" }}
            value={form.message}
            onChange={onChange}
            aria-invalid={Boolean(errors.message)}
          />
        </label>
        <button className="btn btn-primary sidebar-submit" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Sending..." : "Send"}
        </button>
        {status.message ? (
          <p
            className={
              status.type === "success"
                ? "sidebar-contact-status sidebar-contact-status-success"
                : "sidebar-contact-status sidebar-contact-status-error"
            }
          >
            {status.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
