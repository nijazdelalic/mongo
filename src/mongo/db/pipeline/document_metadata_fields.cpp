/**
 *    Copyright (C) 2019-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#include "mongo/platform/basic.h"

#include "mongo/db/pipeline/document_metadata_fields.h"

namespace mongo {

DocumentMetadataFields::DocumentMetadataFields(const DocumentMetadataFields& other)
    : _holder(other._holder ? std::make_unique<MetadataHolder>(*other._holder) : nullptr) {}

DocumentMetadataFields& DocumentMetadataFields::operator=(const DocumentMetadataFields& other) {
    _holder = other._holder ? std::make_unique<MetadataHolder>(*other._holder) : nullptr;
    return *this;
}

DocumentMetadataFields::DocumentMetadataFields(DocumentMetadataFields&& other)
    : _holder(std::move(other._holder)) {}

DocumentMetadataFields& DocumentMetadataFields::operator=(DocumentMetadataFields&& other) {
    _holder = std::move(other._holder);
    return *this;
}

void DocumentMetadataFields::mergeWith(const DocumentMetadataFields& other) {
    if (!hasTextScore() && other.hasTextScore()) {
        setTextScore(other.getTextScore());
    }
    if (!hasRandVal() && other.hasRandVal()) {
        setRandVal(other.getRandVal());
    }
    if (!hasSortKey() && other.hasSortKey()) {
        setSortKey(other.getSortKey());
    }
    if (!hasGeoNearDistance() && other.hasGeoNearDistance()) {
        setGeoNearDistance(other.getGeoNearDistance());
    }
    if (!hasGeoNearPoint() && other.hasGeoNearPoint()) {
        setGeoNearPoint(other.getGeoNearPoint());
    }
    if (!hasSearchScore() && other.hasSearchScore()) {
        setSearchScore(other.getSearchScore());
    }
    if (!hasSearchHighlights() && other.hasSearchHighlights()) {
        setSearchHighlights(other.getSearchHighlights());
    }
    if (!hasIndexKey() && other.hasIndexKey()) {
        setIndexKey(other.getIndexKey());
    }
}

void DocumentMetadataFields::copyFrom(const DocumentMetadataFields& other) {
    if (other.hasTextScore()) {
        setTextScore(other.getTextScore());
    }
    if (other.hasRandVal()) {
        setRandVal(other.getRandVal());
    }
    if (other.hasSortKey()) {
        setSortKey(other.getSortKey());
    }
    if (other.hasGeoNearDistance()) {
        setGeoNearDistance(other.getGeoNearDistance());
    }
    if (other.hasGeoNearPoint()) {
        setGeoNearPoint(other.getGeoNearPoint());
    }
    if (other.hasSearchScore()) {
        setSearchScore(other.getSearchScore());
    }
    if (other.hasSearchHighlights()) {
        setSearchHighlights(other.getSearchHighlights());
    }
    if (other.hasIndexKey()) {
        setIndexKey(other.getIndexKey());
    }
}

size_t DocumentMetadataFields::getApproximateSize() const {
    if (!_holder) {
        return 0;
    }

    // Purposefully exclude the size of the DocumentMetadataFields, as this is accounted for
    // elsewhere. Here we only consider the "deep" size of the MetadataHolder.
    size_t size = sizeof(MetadataHolder);

    // Count the "deep" portion of the metadata values.
    size += _holder->sortKey.objsize();
    size += _holder->geoNearPoint.getApproximateSize();
    // Size of Value is double counted - once in sizeof(MetadataFields) and once in
    // getApproximateSize()
    size -= sizeof(_holder->geoNearPoint);
    size += _holder->searchHighlights.getApproximateSize();
    size -= sizeof(_holder->searchHighlights);
    size += _holder->indexKey.objsize();

    return size;
}

void DocumentMetadataFields::serializeForSorter(BufBuilder& buf) const {
    // If there is no metadata, all we need to do is write a zero byte.
    if (!_holder) {
        buf.appendNum(static_cast<char>(0));
        return;
    }

    if (hasTextScore()) {
        buf.appendNum(static_cast<char>(MetaType::TEXT_SCORE + 1));
        buf.appendNum(getTextScore());
    }
    if (hasRandVal()) {
        buf.appendNum(static_cast<char>(MetaType::RAND_VAL + 1));
        buf.appendNum(getRandVal());
    }
    if (hasSortKey()) {
        buf.appendNum(static_cast<char>(MetaType::SORT_KEY + 1));
        getSortKey().appendSelfToBufBuilder(buf);
    }
    if (hasGeoNearDistance()) {
        buf.appendNum(static_cast<char>(MetaType::GEONEAR_DIST + 1));
        buf.appendNum(getGeoNearDistance());
    }
    if (hasGeoNearPoint()) {
        buf.appendNum(static_cast<char>(MetaType::GEONEAR_POINT + 1));
        getGeoNearPoint().serializeForSorter(buf);
    }
    if (hasSearchScore()) {
        buf.appendNum(static_cast<char>(MetaType::SEARCH_SCORE + 1));
        buf.appendNum(getSearchScore());
    }
    if (hasSearchHighlights()) {
        buf.appendNum(static_cast<char>(MetaType::SEARCH_HIGHLIGHTS + 1));
        getSearchHighlights().serializeForSorter(buf);
    }
    if (hasIndexKey()) {
        buf.appendNum(static_cast<char>(MetaType::INDEX_KEY + 1));
        getIndexKey().appendSelfToBufBuilder(buf);
    }
    buf.appendNum(static_cast<char>(0));
}

void DocumentMetadataFields::deserializeForSorter(BufReader& buf, DocumentMetadataFields* out) {
    invariant(out);

    while (char marker = buf.read<char>()) {
        if (marker == static_cast<char>(MetaType::TEXT_SCORE) + 1) {
            out->setTextScore(buf.read<LittleEndian<double>>());
        } else if (marker == static_cast<char>(MetaType::RAND_VAL) + 1) {
            out->setRandVal(buf.read<LittleEndian<double>>());
        } else if (marker == static_cast<char>(MetaType::SORT_KEY) + 1) {
            out->setSortKey(
                BSONObj::deserializeForSorter(buf, BSONObj::SorterDeserializeSettings()));
        } else if (marker == static_cast<char>(MetaType::GEONEAR_DIST) + 1) {
            out->setGeoNearDistance(buf.read<LittleEndian<double>>());
        } else if (marker == static_cast<char>(MetaType::GEONEAR_POINT) + 1) {
            out->setGeoNearPoint(
                Value::deserializeForSorter(buf, Value::SorterDeserializeSettings()));
        } else if (marker == static_cast<char>(MetaType::SEARCH_SCORE) + 1) {
            out->setSearchScore(buf.read<LittleEndian<double>>());
        } else if (marker == static_cast<char>(MetaType::SEARCH_HIGHLIGHTS) + 1) {
            out->setSearchHighlights(
                Value::deserializeForSorter(buf, Value::SorterDeserializeSettings()));
        } else if (marker == static_cast<char>(MetaType::INDEX_KEY) + 1) {
            out->setIndexKey(
                BSONObj::deserializeForSorter(buf, BSONObj::SorterDeserializeSettings()));
        } else {
            uasserted(28744, "Unrecognized marker, unable to deserialize buffer");
        }
    }
}

}  // namespace mongo
