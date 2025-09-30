export function wiggleLogos() {
    document.querySelectorAll(".app-logo").forEach((logo) => {
        logo.classList.add("wiggle-on-load");
        logo.addEventListener(
            "animationend",
            () => {
            logo.classList.remove("wiggle-on-load");
            },
            { once: true }
        );
    });
}

// MAKE WORM DANCE
export function setupLogoDance() {
    const dances = ["dance1", "dance2", "dance3"];
    let danceIndex = 0;
    const logo = document.querySelectorAll(".app-logo").forEach((logo) => {
    // On hover, play the next dance in the list
        logo.addEventListener("mouseenter", () => {
            const anim = dances[danceIndex];
            logo.style.animation = `${anim} 0.8s ease-in-out`;
            // advance, wrapping back to 0 when we hit the end
            danceIndex = (danceIndex + 1) % dances.length;
        });

    // Clear after each animation so it can retrigger on next hover
        logo.addEventListener("animationend", () => {
            logo.style.animation = "";
        });
    });
}