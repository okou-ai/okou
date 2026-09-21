macro_rules! runner_test_group {
    (executor $(, $rest:ident)*; $item:item) => {
        $item
    };
    ($group:ident $(, $rest:ident)*; $item:item) => {
        runner_test_group!($($rest),*; $item);
    };
    (; $item:item) => {};
}

macro_rules! runner_test_support {
    (executor; $item:item) => {
        $item
    };
    ($owner:ident; $item:item) => {
        #[allow(dead_code, unused_imports)]
        $item
    };
}

include!("../src/runner.rs");
