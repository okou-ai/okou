import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-side-effect-in-render.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("no-side-effect-in-render", rule, {
  valid: [
    // set() inside event handler callback — OK
    {
      code: `
        function MyView() {
          const set = useSet();
          return <button onClick={() => { set(cmd$); }}>Go</button>;
        }
      `,
    },
    // detach() inside event handler callback — OK
    {
      code: `
        function MyView() {
          const set = useSet();
          return <button onClick={() => {
            detach(set(cmd$), Reason.DomCallback);
          }}>Go</button>;
        }
      `,
    },
    // set() inside nested function — OK
    {
      code: `
        function MyView() {
          const set = useSet();
          const handleClick = () => {
            set(cmd$);
          };
          return <button onClick={handleClick}>Go</button>;
        }
      `,
    },
    // detach() inside nested function — OK
    {
      code: `
        function MyView() {
          const set = useSet();
          const handleClick = () => {
            detach(set(cmd$), Reason.DomCallback);
          };
          return <button onClick={handleClick}>Go</button>;
        }
      `,
    },
    // Non-component function (lowercase) — not checked
    {
      code: `
        function helper() {
          const set = useSet();
          set(cmd$);
          return null;
        }
      `,
    },
    // No useSet() — regular function calls are fine
    {
      code: `
        function MyView() {
          const data = formatDate(new Date());
          return <div>{data}</div>;
        }
      `,
    },
    // Arrow component with set() in callback — OK
    {
      code: `
        const MyView = () => {
          const set = useSet();
          return <button onClick={() => set(cmd$)}>Go</button>;
        };
      `,
    },
    // detach inside useEffect-like callback — OK
    {
      code: `
        function MyView() {
          useEffect(() => {
            detach(somePromise, Reason.Effect);
          }, []);
          return <div />;
        }
      `,
    },
    // set() in a function expression callback — OK
    {
      code: `
        function MyView() {
          const set = useSet();
          useEffect(function() {
            set(cmd$);
          }, []);
          return <div />;
        }
      `,
    },
    // Multiple components — scoping is correct
    {
      code: `
        function ViewA() {
          const set = useSet();
          return <button onClick={() => set(cmd$)}>A</button>;
        }
        function ViewB() {
          const set = useSet();
          return <button onClick={() => set(cmd$)}>B</button>;
        }
      `,
    },
  ],
  invalid: [
    // set() directly in render body
    {
      code: `
        function MyView() {
          const set = useSet();
          set(fetchCommand$);
          return <div />;
        }
      `,
      errors: [{ messageId: "noSetInRender" }],
    },
    // Immediately invoking a useSet() result in render
    {
      code: `
        function MyView() {
          useSet(initSettingsForm$)({ name: "Nova" });
          return <div />;
        }
      `,
      errors: [{ messageId: "noSetInRender" }],
    },
    // detach() directly in render body
    {
      code: `
        function MyView() {
          detach(somePromise, Reason.DomCallback);
          return <div />;
        }
      `,
      errors: [{ messageId: "noSideEffectInRender", data: { name: "detach" } }],
    },
    // Both set() and detach() in render body
    {
      code: `
        function MyView() {
          const set = useSet();
          set(cmd$);
          detach(promise, Reason.DomCallback);
          return <div />;
        }
      `,
      errors: [
        { messageId: "noSetInRender" },
        { messageId: "noSideEffectInRender", data: { name: "detach" } },
      ],
    },
    // set() in conditional — still in render body
    {
      code: `
        function MyView() {
          const set = useSet();
          if (condition) {
            set(cmd$);
          }
          return <div />;
        }
      `,
      errors: [{ messageId: "noSetInRender" }],
    },
    // Arrow component with set() in render
    {
      code: `
        const MyView = () => {
          const set = useSet();
          set(cmd$);
          return <div />;
        };
      `,
      errors: [{ messageId: "noSetInRender" }],
    },
    // detach() with custom forbidden calls option
    {
      code: `
        function MyView() {
          fetchData();
          return <div />;
        }
      `,
      options: [{ forbiddenCalls: ["fetchData"] }],
      errors: [
        {
          messageId: "noSideEffectInRender",
          data: { name: "fetchData" },
        },
      ],
    },
    // set() with renamed setter
    {
      code: `
        function MyView() {
          const dispatch = useSet();
          dispatch(cmd$);
          return <div />;
        }
      `,
      errors: [{ messageId: "noSetInRender" }],
    },
  ],
});
