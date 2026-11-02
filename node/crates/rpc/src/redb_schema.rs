//! Shared redb table/metadata schema checks for node-local stores.

use redb::{Database, ReadableDatabase, TableHandle};

pub fn require_tables(db: &Database, expected_tables: &[&str]) -> Result<(), String> {
    let read = db.begin_read().map_err(|error| error.to_string())?;
    let mut tables = read
        .list_tables()
        .map_err(|error| error.to_string())?
        .map(|table| table.name().to_owned())
        .collect::<Vec<_>>();
    tables.sort_unstable();
    let mut expected = expected_tables
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    expected.sort_unstable();
    if tables != expected
        || read
            .list_multimap_tables()
            .map_err(|error| error.to_string())?
            .count()
            != 0
    {
        return Err("incompatible table schema".into());
    }
    Ok(())
}

pub fn require_meta_keys<K: AsRef<[u8]>>(
    mut keys: Vec<K>,
    allowed_sets: &[&[&[u8]]],
) -> Result<(), String> {
    keys.sort_unstable_by(|left, right| left.as_ref().cmp(right.as_ref()));
    let actual = keys.iter().map(K::as_ref).collect::<Vec<_>>();
    for set in allowed_sets {
        let mut expected = set.to_vec();
        expected.sort_unstable();
        if actual == expected {
            return Ok(());
        }
    }
    Err("incompatible metadata schema".into())
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests use direct assertions"
)]
mod tests {
    use super::*;
    use redb::TableDefinition;

    const T1: TableDefinition<&str, &str> = TableDefinition::new("alpha");
    const T2: TableDefinition<&str, &str> = TableDefinition::new("beta");

    #[test]
    fn require_tables_validates_exact_set() {
        let db = Database::builder()
            .create_with_backend(redb::backends::InMemoryBackend::new())
            .unwrap();

        {
            let write = db.begin_write().unwrap();
            let _ = write.open_table(T1).unwrap();
            let _ = write.open_table(T2).unwrap();
            write.commit().unwrap();
        }

        assert!(require_tables(&db, &["alpha", "beta"]).is_ok());
        assert!(require_tables(&db, &["beta", "alpha"]).is_ok());
        assert!(require_tables(&db, &["alpha"]).is_err());
        assert!(require_tables(&db, &["alpha", "beta", "gamma"]).is_err());
    }

    #[test]
    fn require_meta_keys_validates_sets() {
        let allowed1: &[&[u8]] = &[b"version", b"chain_id"];
        let allowed2: &[&[u8]] = &[b"version", b"chain_id", b"extra"];
        let allowed_sets = &[allowed1, allowed2];

        assert!(require_meta_keys(vec![&b"chain_id"[..], &b"version"[..]], allowed_sets).is_ok());
        assert!(require_meta_keys(
            vec![&b"version"[..], &b"chain_id"[..], &b"extra"[..]],
            allowed_sets
        )
        .is_ok());
        assert!(require_meta_keys(vec![&b"version"[..]], allowed_sets).is_err());
        assert!(require_meta_keys(vec![&b"version"[..], &b"other"[..]], allowed_sets).is_err());
    }
}
