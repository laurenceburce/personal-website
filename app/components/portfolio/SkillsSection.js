"use client";

import { motion, useReducedMotion } from "framer-motion";

const CARD_SPRING = { type: "spring", stiffness: 300, damping: 20 };
const TAG_SPRING  = { type: "spring", stiffness: 420, damping: 22 };

export default function SkillsSection({ skillGroups }) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <section id="skills" className="section reveal">
      <div className="section-head">
        <h2>Skills</h2>
        <p>Core technologies grouped by area of focus.</p>
      </div>
      <div className="skills-groups">
        {skillGroups.map((group) => (
          <motion.article
            className="skill-group"
            key={group.title}
            whileHover={
              !shouldReduceMotion ? { y: -4, transition: CARD_SPRING } : {}
            }
          >
            <h3>{group.title}</h3>
            <ul className="skill-list">
              {group.items.map((skill) => (
                <motion.li
                  key={`${group.title}-${skill}`}
                  whileHover={
                    !shouldReduceMotion
                      ? { scale: 1.08, y: -2, transition: TAG_SPRING }
                      : {}
                  }
                  whileTap={
                    !shouldReduceMotion
                      ? { scale: 0.94, transition: TAG_SPRING }
                      : {}
                  }
                >
                  {skill}
                </motion.li>
              ))}
            </ul>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
