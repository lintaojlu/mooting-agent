cmake_minimum_required(VERSION 3.22.1)
project(s23u_glasses_lc3 C)

# Google liblc3 v1.1.3, vendored from https://github.com/google/liblc3/tree/v1.1.3.
set(LC3_SRC liblc3/src)
add_library(s23u_glasses_lc3 SHARED
    glasses_lc3.c
    ${LC3_SRC}/attdet.c
    ${LC3_SRC}/bits.c
    ${LC3_SRC}/bwdet.c
    ${LC3_SRC}/energy.c
    ${LC3_SRC}/lc3.c
    ${LC3_SRC}/ltpf.c
    ${LC3_SRC}/mdct.c
    ${LC3_SRC}/plc.c
    ${LC3_SRC}/sns.c
    ${LC3_SRC}/spec.c
    ${LC3_SRC}/tables.c
    ${LC3_SRC}/tns.c
)
target_include_directories(s23u_glasses_lc3 PRIVATE liblc3/include)
set_target_properties(s23u_glasses_lc3 PROPERTIES C_VISIBILITY_PRESET hidden)
target_link_libraries(s23u_glasses_lc3 PRIVATE m)

add_library(mooting_node SHARED mooting_node.c)
target_link_libraries(mooting_node PRIVATE c++_shared dl log)
