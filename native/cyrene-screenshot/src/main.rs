fn main() {
    if let Err(error) = cyrene_screenshot::cli::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
