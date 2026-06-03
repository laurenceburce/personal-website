export default function SkillsSection({ skillGroups }) {
  return (
    <section id="skills" className="section reveal">
      <div className="section-head">
        <h2>Skills</h2>
        <p>Core technologies grouped by area of focus.</p>
      </div>
      <div className="skills-groups">
        {skillGroups.map((group) => (
          <article className="skill-group" key={group.title}>
            <h3>{group.title}</h3>
            <ul className="skill-list">
              {group.items.map((skill) => (
                <li key={`${group.title}-${skill}`}>{skill}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
