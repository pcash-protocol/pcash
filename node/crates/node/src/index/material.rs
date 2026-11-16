use redb::TableError;

use alloy_primitives::Address;
use pcash_state::{Codec, StateError};

use super::keys::{
    be, contract_creation_key, receive_material_key, T_CONTRACT_BY_CREATION, T_CONTRACT_MATERIAL,
    T_CONTRACT_SOURCE_INFO, T_RECEIVE_MATERIAL, T_VERIFIED_CONTRACT_BY_CREATION,
};
use super::store::{IndexReadSource, IndexStore};
use super::types::{ContractMaterialUpdate, ContractSourceInfo, ReceiveMaterialUpdate};

impl<D: IndexReadSource> IndexStore<D> {
    pub fn receive_material(
        &self,
        address: Address,
        account_revision: u32,
    ) -> Result<Option<ReceiveMaterialUpdate>, StateError> {
        let read = self.db.read_transaction()?;
        let table = match read.open_table(T_RECEIVE_MATERIAL) {
            Ok(table) => table,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(error) => return Err(be(error)),
        };
        let key = receive_material_key(&address, account_revision);
        table
            .get(key.as_slice())
            .map_err(be)?
            .map(|value| ReceiveMaterialUpdate::decode(value.value()).map_err(be))
            .transpose()
    }

    pub fn contract_material(
        &self,
        address: Address,
    ) -> Result<Option<ContractMaterialUpdate>, StateError> {
        let read = self.db.read_transaction()?;
        let table = match read.open_table(T_CONTRACT_MATERIAL) {
            Ok(table) => table,
            Err(TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(error) => return Err(be(error)),
        };
        let Some(value) = table.get(address.as_slice()).map_err(be)? else {
            return Ok(None);
        };
        ContractMaterialUpdate::decode(value.value())
            .map(Some)
            .map_err(be)
    }

    /// A bounded newest-first slice of the chronological contract index.
    /// `cursor` is the last returned creation coordinate and is exclusive.
    pub fn contract_material_page(
        &self,
        anchor_block: u64,
        cursor: Option<(u64, u64)>,
        limit: usize,
    ) -> Result<Vec<ContractMaterialUpdate>, StateError> {
        let read = self.db.read_transaction()?;
        let chronological = match read.open_table(T_CONTRACT_BY_CREATION) {
            Ok(table) => table,
            Err(TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(error) => return Err(be(error)),
        };
        let material = read.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
        let first = contract_creation_key(0, 0);
        let mut rows = Vec::with_capacity(limit);
        if let Some((block_number, transaction_index)) = cursor {
            let last = contract_creation_key(block_number, transaction_index);
            for row in chronological
                .range(first.as_slice()..last.as_slice())
                .map_err(be)?
                .rev()
                .take(limit)
            {
                rows.push(row.map_err(be)?);
            }
        } else {
            let last = contract_creation_key(anchor_block, u64::MAX);
            for row in chronological
                .range(first.as_slice()..=last.as_slice())
                .map_err(be)?
                .rev()
                .take(limit)
            {
                rows.push(row.map_err(be)?);
            }
        }
        rows.into_iter()
            .map(|(_key, address)| {
                let stored = material.get(address.value()).map_err(be)?.ok_or_else(|| {
                    StateError::Backend("derived contract creation material is missing".into())
                })?;
                ContractMaterialUpdate::decode(stored.value()).map_err(be)
            })
            .collect()
    }

    pub fn contract_material_at(
        &self,
        block_number: u64,
        transaction_index: u64,
    ) -> Result<Option<ContractMaterialUpdate>, StateError> {
        let read = self.db.read_transaction()?;
        let chronological = read.open_table(T_CONTRACT_BY_CREATION).map_err(be)?;
        let key = contract_creation_key(block_number, transaction_index);
        let Some(address) = chronological.get(key.as_slice()).map_err(be)? else {
            return Ok(None);
        };
        let material = read.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
        let stored = material.get(address.value()).map_err(be)?.ok_or_else(|| {
            StateError::Backend("derived contract creation material is missing".into())
        })?;
        let stored = ContractMaterialUpdate::decode(stored.value()).map_err(be)?;
        Ok(Some(stored))
    }

    /// The indexed verification status and configuration-opening count of one contract.
    pub fn contract_source_info(
        &self,
        address: Address,
    ) -> Result<Option<ContractSourceInfo>, StateError> {
        let read = self.db.read_transaction()?;
        let table = read.open_table(T_CONTRACT_SOURCE_INFO).map_err(be)?;
        let Some(value) = table.get(address.as_slice()).map_err(be)? else {
            return Ok(None);
        };
        ContractSourceInfo::decode(value.value())
            .map(Some)
            .map_err(be)
    }

    /// A bounded newest-first slice of the verified contracts, ordered and paged
    /// exactly like [`DerivedIndexStore::contract_material_page`].
    pub fn verified_contract_page(
        &self,
        head_block: u64,
        before: Option<(u64, u64)>,
        limit: usize,
    ) -> Result<Vec<ContractMaterialUpdate>, StateError> {
        let read = self.db.read_transaction()?;
        let chronological = read
            .open_table(T_VERIFIED_CONTRACT_BY_CREATION)
            .map_err(be)?;
        let material = read.open_table(T_CONTRACT_MATERIAL).map_err(be)?;
        let first = contract_creation_key(0, 0);
        let mut rows = Vec::with_capacity(limit);
        if let Some((block_number, transaction_index)) = before {
            let last = contract_creation_key(block_number, transaction_index);
            for row in chronological
                .range(first.as_slice()..last.as_slice())
                .map_err(be)?
                .rev()
                .take(limit)
            {
                rows.push(row.map_err(be)?);
            }
        } else {
            let last = contract_creation_key(head_block, u64::MAX);
            for row in chronological
                .range(first.as_slice()..=last.as_slice())
                .map_err(be)?
                .rev()
                .take(limit)
            {
                rows.push(row.map_err(be)?);
            }
        }
        rows.into_iter()
            .map(|(_, address)| {
                let stored = material.get(address.value()).map_err(be)?.ok_or_else(|| {
                    StateError::Backend("derived verified contract material is missing".into())
                })?;
                ContractMaterialUpdate::decode(stored.value()).map_err(be)
            })
            .collect()
    }

    /// The verified contract created at an exact block coordinate.
    pub fn verified_contract_at(
        &self,
        block_number: u64,
        transaction_index: u64,
    ) -> Result<Option<Address>, StateError> {
        let read = self.db.read_transaction()?;
        let chronological = read
            .open_table(T_VERIFIED_CONTRACT_BY_CREATION)
            .map_err(be)?;
        let key = contract_creation_key(block_number, transaction_index);
        let Some(address) = chronological.get(key.as_slice()).map_err(be)? else {
            return Ok(None);
        };
        Ok(Some(Address::from_slice(address.value())))
    }
}
