import TimelineEntry from "./TimelineEntry";

export default function WorkSection({ timeline }) {
  return (
    <section id="work" className="section reveal">
      <div className="section-head">
        <h2>Work Experience</h2>
      </div>
      <div className="timeline">
        {timeline.map((entry) => (
          <TimelineEntry entry={entry} key={entry.company} />
        ))}
      </div>
    </section>
  );
}
