/**
 * The © Powered by SHCS footer credit — bold and colorfully visible on every
 * page of the app.
 */
export function ShcsCredit() {
  return (
    <p className="text-center text-sm leading-5">
      <span className="text-base font-extrabold text-amber-400">©</span>{" "}
      <span className="bg-gradient-to-r from-amber-400 via-orange-400 to-pink-500 bg-clip-text text-sm font-extrabold tracking-wide text-transparent">
        Powered by SHCS
      </span>
    </p>
  );
}
