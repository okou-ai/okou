macro_rules! runner_test_group {
    ($($group:ident),+; $item:item) => {
        $item
    };
}

macro_rules! runner_test_support {
    ($owner:ident; $item:item) => {
        $item
    };
}

include!("runner.rs");
